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

const upload = multer({ dest: uploadsDir });

app.use(express.json());

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let uploadedPath = null;

  try {
    uploadedPath = req.file.path;

    const systemPrompt = `
Extract structured data from a Norwegian electricity invoice.

Return ONLY JSON.

Rules:
- Numbers must be numbers (no units)
- Do not guess
- Missing → null

IMPORTANT:
- Extract ALL additional services INCLUDING price and unit
- Format: "<name> <value> <unit>"

Example:
"Papirfaktura 8,32 kr"
"Påslag 7.95 øre/kWh"
`;

    const schema = {
      type: "json_schema",
      name: "invoice",
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

    const fileBuffer = fs.readFileSync(uploadedPath);

    const openaiFile = await client.files.create({
      file: await toFile(fileBuffer, req.file.originalname),
      purpose: "user_data",
    });

    const response = await client.responses.create({
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

    const parsed = JSON.parse(response.output_text);

    const formatted = formatOutput(parsed);

    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      fs.unlinkSync(uploadedPath);
    }
  }
});

// =========================
// 🔥 SMART UNIT DETECTION
// =========================

function detectUnit(field, data) {
  const services = data.additional_services?.join(" ").toLowerCase() || "";

  if (services.includes("øre/kwh")) return "øre/kWh";
  if (services.includes("kr/mnd")) return "kr/mnd";
  if (services.includes("kr")) return "kr";

  // fallback by field
  if (field === "electricity_price" || field === "surcharge")
    return "øre/kWh";

  if (field === "fixed_cost" || field === "total_costs") return "kr";

  if (field.includes("consumption")) return "kWh";

  return "";
}

// =========================
// 🎯 FORMATTER
// =========================

function formatOutput(data) {
  return {
    name: data.name,
    address: formatText(data.address),
    supplier: data.supplier,
    invoice_date: data.invoice_date,

    annual_consumption: formatValue(
      data.annual_consumption,
      detectUnit("annual_consumption", data)
    ),

    meter_number: data.meter_number,
    agreement_name: data.agreement_name,
    price_area: data.price_area,

    surcharge: formatValue(
      data.surcharge,
      detectUnit("surcharge", data)
    ),

    fixed_cost: formatValue(
      data.fixed_cost,
      detectUnit("fixed_cost", data)
    ),

    period: normalizePeriod(data.period),

    "period consumption": formatValue(
      data.period_consumption,
      detectUnit("period_consumption", data)
    ),

    electricity_price: formatValue(
      data.electricity_price,
      detectUnit("electricity_price", data)
    ),

    additional_services: data.additional_services?.join(", ") || null,

    total_costs: formatValue(
      data.total_costs,
      detectUnit("total_costs", data),
      true
    ),
  };
}

// =========================
// HELPERS
// =========================

function formatValue(value, unit, isCurrency = false) {
  if (value == null) return null;

  if (isCurrency) {
    return `${value.toLocaleString("en-US")} ${unit}`;
  }

  return unit ? `${value} ${unit}` : `${value}`;
}

function formatText(text) {
  if (!text) return null;
  return text
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizePeriod(period) {
  if (!period) return null;
  return period.replace(
    /(\d{2})\.(\d{2})\.(\d{2})/g,
    (_, d, m, y) => `${d}.${m}.20${y}`
  );
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});