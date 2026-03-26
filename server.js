import express from "express";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI, { toFile } from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const uploadsDir = "uploads";
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const allowedMimeTypes = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
];

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Only PDF, PNG, JPG/JPEG, and WEBP are allowed."));
    }
    cb(null, true);
  },
});

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Electricity invoice parser API is running",
  });
});

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let uploadedPath = null;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "OPENAI_API_KEY is missing.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Use form-data key "file".',
      });
    }

    uploadedPath = req.file.path;

    const systemPrompt = `
You are an expert data extraction system specialized in Norwegian electricity invoices.

Return ONLY valid JSON. No explanations.

GENERAL RULES:
- Do NOT guess values
- Missing values → null
- Numbers must be numbers (no units)
- Extract values exactly as shown in the document
- Dates → DD.MM.YYYY format when possible

FIELDS TO EXTRACT:
name, address, supplier, invoice_date, annual_consumption,
meter_number, agreement_name, price_area,
surcharge, fixed_cost, period, period_consumption,
electricity_price, additional_services, total_costs, missing_fields

FIELD HINTS:
- Fakturadato → invoice_date
- Målepunkt / Målernummer → meter_number
- Påslag → surcharge
- Fastbeløp → fixed_cost
- Forbruk → consumption
- Totalt å betale → total_costs

IMPORTANT RULES FOR additional_services:

- additional_services must include ALL non-energy extra costs, services, or fees

- A service is ANY line item that is NOT:
  - electricity usage (kWh cost)
  - total cost
  - main grid/transport charges unless clearly an add-on

- Each service MUST include:
  1. Full service name (exactly as written)
  2. Its corresponding price/value
  3. Unit if present (kr, øre/kWh, %, kr/mnd, etc.)

- ALWAYS combine name + price in ONE string

- Format:
  "<service name> <value> <unit>"

- Examples:
  "Papirfaktura 8,32 kr"


- Prices may be located in a different column or row than the service name — match them correctly

- NEVER return a service without a price if a price exists anywhere in the invoice

- If no price exists → return only the name

- Extract services even if they appear in:
  - tables
  - footnotes
  - small text sections

- additional_services must be an array of strings
`.trim();

    const schema = {
      type: "json_schema",
      name: "electricity_invoice_extraction",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          supplier: { type: ["string", "null"] },
          invoice_date: { type: ["string", "null"] },
          annual_consumption: { type: ["number", "null"] },
          meter_number: { type: ["string", "null"] },
          agreement_name: { type: ["string", "null"] },
          price_area: { type: ["string", "null"] },
          surcharge: { type: ["number", "null"] },
          fixed_cost: { type: ["number", "null"] },
          period: { type: ["string", "null"] },
          period_consumption: { type: ["number", "null"] },
          electricity_price: { type: ["number", "null"] },
          additional_services: {
            type: "array",
            items: { type: "string" },
          },
          total_costs: { type: ["number", "null"] },
          missing_fields: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "name",
          "address",
          "supplier",
          "invoice_date",
          "annual_consumption",
          "meter_number",
          "agreement_name",
          "price_area",
          "surcharge",
          "fixed_cost",
          "period",
          "period_consumption",
          "electricity_price",
          "additional_services",
          "total_costs",
          "missing_fields",
        ],
      },
    };

    let response;

    if (req.file.mimetype === "application/pdf") {
      const fileBuffer = fs.readFileSync(uploadedPath);

      const openaiFile = await client.files.create({
        file: await toFile(fileBuffer, req.file.originalname),
        purpose: "user_data",
      });

      response = await client.responses.create({
        model: "gpt-4o",
        temperature: 0,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [{ type: "input_file", file_id: openaiFile.id }],
          },
        ],
        text: { format: schema },
      });
    } else {
      const base64 = fs.readFileSync(uploadedPath).toString("base64");

      response = await client.responses.create({
        model: "gpt-4o",
        temperature: 0,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: `data:${req.file.mimetype};base64,${base64}`,
              },
            ],
          },
        ],
        text: { format: schema },
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(response.output_text);
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: "Failed to parse OpenAI response",
        raw: response.output_text,
      });
    }

    return res.json(parsed);
  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch {}
    }
  }
});

app.use((err, req, res, next) => {
  return res.status(400).json({
    success: false,
    error: err.message,
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
