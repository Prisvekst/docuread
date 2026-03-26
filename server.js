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
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
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
        error: "OPENAI_API_KEY is missing from the environment variables.",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Use form-data with key "file".',
      });
    }

    uploadedPath = req.file.path;

    // ✅ IMPROVED SYSTEM PROMPT
    const systemPrompt = `
You are an expert data extraction system specialized in electricity invoices.

Your task is to extract structured data and return ONLY valid JSON.

STRICT RULES:
- Output must be valid JSON only.
- Do NOT include explanations or extra text.
- Do NOT hallucinate. If a value is missing, return null.
- Preserve original currency and units exactly as written.
- Keep all numeric values as numbers (no units inside numbers).
- Trim whitespace and clean formatting.
- Normalize dates to DD.MM.YYYY when possible.

FIELD DEFINITIONS:
- name: Customer full name
- address: Customer billing address (NOT supplier or delivery address)
- supplier: Company issuing the invoice
- invoice_date: Invoice issue date (NOT due date / trekkdato)
- annual_consumption: Expected yearly consumption (kWh)
- meter_number: Electricity meter number
- agreement_name: Name of electricity contract
- price_area: Electricity region code (e.g. NO1, NO2)
- surcharge: Additional cost per kWh (number only)
- fixed_cost: Monthly fixed fee (kr)
- period: Billing period (from - to)
- period_consumption: Total kWh used in billing period
- electricity_price: Price per kWh (number only, exclude surcharge)
- additional_services: List of extra charges with price (strings)
- total_costs: Total amount to pay

DISAMBIGUATION RULES:
- If multiple dates → use "Fakturadato"
- If multiple addresses → use customer address
- If multiple kWh values → use total consumption for billing period
- If multiple totals → use "Totalt å betale"

EXTRACTION HINTS:
- invoice_date → Fakturadato
- surcharge → Påslag
- fixed_cost → fastbeløp
- period_consumption → near "Din strømpris"
- electricity_price → øre/kWh tied to usage (NOT påslag)
- additional_services → Diverse

If a field is missing, include it in "missing_fields".

Return ONLY JSON.
`.trim();

    // ✅ UPDATED SCHEMA
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
        file: await toFile(fileBuffer, req.file.originalname, {
          type: req.file.mimetype,
        }),
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
      const imageBuffer = fs.readFileSync(uploadedPath);
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

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
            content: [{ type: "input_image", image_url: dataUrl }],
          },
        ],
        text: { format: schema },
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(response.output_text);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Could not parse JSON from the OpenAI response.",
        raw_output: response.output_text || null,
      });
    }

    return res.status(200).json(parsed);
  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Unknown server error",
    });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.error("Could not delete temp file:", cleanupError.message);
      }
    }
  }
});

app.use((err, req, res, next) => {
  return res.status(400).json({
    success: false,
    error: err.message || "Error uploading file",
  });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});