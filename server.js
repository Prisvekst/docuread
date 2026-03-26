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
        error: 'No file uploaded. Use key "file".',
      });
    }

    uploadedPath = req.file.path;

    const systemPrompt = `
You are an expert data extraction system specialized in electricity invoices.

Return ONLY valid JSON.

RULES:
- Do NOT include explanations
- Do NOT hallucinate
- Missing values → null
- Numbers must be numbers (no units)

FIELDS:
name, address, supplier, invoice_date, annual_consumption,
meter_number, agreement_name, price_area,
surcharge, fixed_cost, period, period_consumption,
electricity_price, additional_services, total_costs, missing_fields

HINTS:
- Fakturadato → invoice_date
- Påslag → surcharge
- fastbeløp → fixed_cost
- Totalt å betale → total_costs
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

    const parsed = JSON.parse(response.output_text);

    // ✅ FORMATTER (THIS FIXES YOUR OUTPUT)
    const formatted = formatInvoice(parsed);

    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      fs.unlinkSync(uploadedPath);
    }
  }
});

// =====================
// ✅ FORMAT FUNCTIONS
// =====================

function formatInvoice(data) {
  return {
    name: data.name,
    address: formatAddress(data.address),
    supplier: data.supplier,
    invoice_date: data.invoice_date,

    annual_consumption:
      data.annual_consumption != null
        ? `${data.annual_consumption} kWh`
        : null,

    meter_number: data.meter_number,
    agreement_name: data.agreement_name,

    price_area: formatPriceArea(data.price_area),

    surcharge:
      data.surcharge != null
        ? `${data.surcharge} øre/kWh`
        : null,

    fixed_cost:
      data.fixed_cost != null
        ? `${data.fixed_cost.toFixed(2)} kr/mnd`
        : null,

    period: formatPeriod(data.period),

    "period consumption":
      data.period_consumption != null
        ? `${data.period_consumption} kWh`
        : null,

    electricity_price:
      data.electricity_price != null
        ? `${data.electricity_price} øre/kWh`
        : null,

    additional_services:
      data.additional_services?.length
        ? data.additional_services
            .map((s) => {
              const match = s.match(/(.+)\s([\d.,]+)/);
              if (!match) return s;
              return `${match[1]} (${match[2].replace(",", ".")} kr)`;
            })
            .join(", ")
        : null,

    total_costs:
      data.total_costs != null
        ? `${data.total_costs.toLocaleString("en-US")} kr`
        : null,
  };
}

function formatAddress(address) {
  if (!address) return null;
  return address
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPriceArea(area) {
  const map = {
    NO1: "Øst-Norge (NO1)",
    NO2: "Sør-Norge (NO2)",
    NO3: "Midt-Norge (NO3)",
    NO4: "Nord-Norge (NO4)",
    NO5: "Vest-Norge (NO5)",
  };
  return map[area] || area;
}

function formatPeriod(period) {
  if (!period) return null;
  return period.replace(
    /(\d{2})\.(\d{2})\.(\d{2})/g,
    (_, d, m, y) => `${d}.${m}.20${y}`
  );
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
