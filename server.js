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

/** Stable JSON key order (some clients reorder plain objects). */
const OUTPUT_KEY_ORDER = [
  "name",
  "address",
  "period",
  "invoice_date",
  "supplier",
  "price_area",
  "meter_number",
  "meter_id",
  "agreement_name",
  "surcharge",
  "fixed_cost",
  "electricity_price",
  "total_costs",
  "additional_services",
  "annual_consumption",
  "period_consumption",
];

function orderKeys(obj, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      out[k] = obj[k];
    }
  }
  return out;
}

app.use(express.json());

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let path = req.file.path;

  try {
    const buffer = fs.readFileSync(path);

    const file = await client.files.create({
      file: await toFile(buffer, req.file.originalname),
      purpose: "user_data",
    });

    // 🔥 AI-FIRST PROMPT (UPDATED)
    const systemPrompt = `
You are an expert at reading Norwegian electricity invoices.

Return ONLY valid JSON.

------------------------
GENERAL RULES
------------------------

- Do NOT guess values
- If a value is missing → return null
- Choose the most correct value when multiple exist

------------------------
FORMATTING RULES
------------------------

Dates:
- Format: DD.MM.YYYY

Periods:
- Format: "DD.MM.YYYY - DD.MM.YYYY"
- Convert:
  "hele april 2025" → "01.04.2025 - 30.04.2025"

Numbers:
- Use dot as decimal separator

------------------------
FIELD DEFINITIONS
------------------------

electricity_price:
- Price per kWh (øre/kWh)
- Only use values labeled "øre/kWh"

surcharge:
- Additional cost per kWh (øre/kWh)
- Only use values labeled "øre/kWh"

fixed_cost:
- Monthly fee (kr/mnd)

total_costs:
- Electricity cost ONLY (strøm)
- Prefer "Sum" or "Total" or typically one of the biggest cost related numbers
- Ignore "Totalt å betale" and "Nettleie"

meter_id:
- Metering point ID (målepunkt-ID)
- Numeric string
- Typically starts with 7070575000
- Usually 18 digits
- Extract full number exactly
- Do NOT confuse with meter_number

------------------------
ADDITIONAL SERVICES
------------------------

- Include ONLY services not already in other fields
- Exclude abonnement, fastbeløp, påslag

- Format:
  "Service Name (value unit)"

- Example:
  "Papirfaktura (8.32 kr)"

- If none → null

------------------------
FINAL OUTPUT
------------------------

Return ONLY JSON matching schema.
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
          period: { type: ["string", "null"] },
          invoice_date: { type: ["string", "null"] },
          supplier: { type: ["string", "null"] },
          price_area: { type: ["string", "null"] },
          meter_number: { type: ["string", "null"] },
          meter_id: { type: ["string", "null"] },
          agreement_name: { type: ["string", "null"] },
          surcharge: { type: ["number", "null"] },
          fixed_cost: { type: ["number", "null"] },
          electricity_price: { type: ["number", "null"] },
          total_costs: { type: ["number", "null"] },
          additional_services: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          annual_consumption: { type: ["number", "null"] },
          period_consumption: { type: ["number", "null"] },
          missing_fields: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "name",
          "address",
          "period",
          "invoice_date",
          "supplier",
          "price_area",
          "meter_number",
          "meter_id",
          "agreement_name",
          "surcharge",
          "fixed_cost",
          "electricity_price",
          "total_costs",
          "additional_services",
          "annual_consumption",
          "period_consumption",
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

    return res.json(orderKeys(formatted, OUTPUT_KEY_ORDER));
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
    period: formatPeriod(data.period),
    invoice_date: data.invoice_date,
    supplier: data.supplier,
    price_area: data.price_area,
    meter_number: data.meter_number,
    meter_id: data.meter_id,
    agreement_name: data.agreement_name,
    surcharge: formatValue(data.surcharge, "øre/kWh"),
    fixed_cost: formatValue(data.fixed_cost, "kr/mnd"),
    electricity_price: formatValue(data.electricity_price, "øre/kWh"),
    total_costs: formatCurrency(data.total_costs),
    additional_services: formatServices(data.additional_services),
    annual_consumption: formatValue(data.annual_consumption, "kWh"),
    period_consumption: formatValue(data.period_consumption, "kWh"),
  };
}


// =========================
// 🧠 HELPERS
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
  if (!services || !services.length) return null;
  return services.join(", ");
}

function formatPeriod(period) {
  if (!period) return null;
  return period.replace(/\s*-\s*/, " - ");
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