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

const upload = multer({ dest: "uploads/" });

app.use(express.json());

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let path = req.file.path;

  try {
    const buffer = fs.readFileSync(path);

    const file = await client.files.create({
      file: await toFile(buffer, req.file.originalname),
      purpose: "user_data",
    });

    // 🧠 AI-FIRST PROMPT
    const systemPrompt = `
You are an expert at reading Norwegian electricity invoices.

Return structured JSON.

CRITICAL:
Choose the correct meaning, not just numbers.

Field rules:

- electricity_price → price per kWh (øre/kWh)
- surcharge → additional cost per kWh (øre/kWh)
- fixed_cost → monthly fee (kr/mnd)
- total_costs → electricity cost ONLY (strøm), NOT total invoice

Important distinctions:
- "øre/kWh" = rate → use for price fields
- "kr" = total → NEVER use for price fields

- If multiple candidates exist → choose the correct one
- If unsure → return null

- additional_services must include name + price

Be precise. Do not guess.
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
          content: [{ type: "input_file", file_id: file.id }],
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
    if (fs.existsSync(path)) fs.unlinkSync(path);
  }
});


// =========================
// 🎯 LIGHT FORMATTING ONLY
// =========================

function formatOutput(data) {
  return {
    name: data.name,
    address: formatAddress(data.address),
    supplier: data.supplier,
    invoice_date: normalizeDate(data.invoice_date),

    annual_consumption: formatValue(data.annual_consumption, "kWh"),

    meter_number: data.meter_number,
    agreement_name: data.agreement_name,
    price_area: data.price_area,

    surcharge: formatValue(data.surcharge, "øre/kWh"),
    fixed_cost: formatValue(data.fixed_cost, "kr/mnd"),

    period: formatPeriod(data.period),

    "period consumption": formatValue(data.period_consumption, "kWh"),

    electricity_price: formatValue(data.electricity_price, "øre/kWh"),

    additional_services: formatServices(data.additional_services),

    total_costs: formatCurrency(data.total_costs),
  };
}


// =========================
// 🧠 HELPERS (SAFE ONLY)
// =========================

function formatValue(value, unit) {
  if (value == null) return null;
  return `${round(value)} ${unit}`;
}

function formatCurrency(value) {
  if (value == null) return null;
  return `${value.toLocaleString("en-US")} kr`;
}

function formatServices(services) {
  if (!services?.length) return null;
  return services.join(", ");
}

function normalizeDate(date) {
  return date || null;
}

function formatPeriod(period) {
  if (!period) return null;
  return period.replace("-", " - ");
}

function formatAddress(addr) {
  if (!addr) return null;

  return addr
    .toLowerCase()
    .split(" ")
    .map((w) => {
      if (/^\d+[a-z]$/.test(w)) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function round(num) {
  return Math.round(num * 100) / 100;
}


// =========================

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});