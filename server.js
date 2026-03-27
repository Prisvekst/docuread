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

    const systemPrompt = `
Extract structured data from a Norwegian electricity invoice.

Return ONLY JSON.

Rules:
- Numbers must be numbers (no units)
- Missing values → null
- Do not guess

IMPORTANT:
- additional_services must include name + value + unit if present
- Format: "<name> <value> <unit>"
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

    const cleaned = cleanData(parsed);

    return res.json(cleaned);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(path)) fs.unlinkSync(path);
  }
});


// =========================
// 🔥 CLEAN + FORMAT
// =========================

function cleanData(data) {
  return {
    name: data.name,
    address: formatAddress(data.address),
    supplier: data.supplier,
    invoice_date: data.invoice_date,

    annual_consumption: formatUnit(data.annual_consumption, "kWh"),

    meter_number: data.meter_number,
    agreement_name: data.agreement_name,
    price_area: data.price_area,

    surcharge: formatUnit(data.surcharge, "øre/kWh"),
    fixed_cost: formatUnit(data.fixed_cost, "kr/mnd"),

    period: formatPeriod(data.period),

    "period consumption": formatUnit(data.period_consumption, "kWh"),

    electricity_price: formatUnit(data.electricity_price, "øre/kWh"),

    additional_services: cleanServices(data.additional_services, data),

    total_costs: formatCurrency(data.total_costs),
  };
}


// =========================
// ✅ NO DOUBLE COUNTING (BY MEANING)
// =========================

function cleanServices(services, data) {
  if (!services?.length) return null;

  return services
    .map((s) => {
      if (!s) return null;

      const lower = s.toLowerCase();

      // ❌ Remove only if same meaning as structured field

      // Fixed cost duplication
      if (
        data.fixed_cost !== null &&
        (lower.includes("fastbeløp") ||
          lower.includes("abonnement") ||
          lower.includes("mnd"))
      ) {
        return null;
      }

      // Surcharge duplication
      if (
        data.surcharge !== null &&
        lower.includes("påslag")
      ) {
        return null;
      }

      return normalizeService(s);
    })
    .filter(Boolean)
    .join(", ");
}


// =========================
// 🧠 HELPERS
// =========================

function normalizeService(s) {
  if (!s) return null;

  const match = s.match(/(.+?)\s([\d.,]+)\s*(kr|øre\/kwh|kr\/mnd)?/i);

  if (!match) return capitalize(s);

  let [, name, value, unit] = match;

  value = value.replace(",", ".");
  unit = unit ? unit.replace("kwh", "kWh") : "kr";

  return `${capitalize(name)} (${value} ${unit})`;
}

function formatUnit(value, unit) {
  if (value == null) return null;
  return `${value} ${unit}`;
}

function formatCurrency(value) {
  if (value == null) return null;
  return `${value.toLocaleString("en-US")} kr`;
}

function formatAddress(addr) {
  if (!addr) return null;

  return addr
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPeriod(period) {
  if (!period) return null;

  return period
    .replace(
      /(\d{2})\.(\d{2})\.(\d{2})/g,
      (_, d, m, y) => `${d}.${m}.20${y}`
    )
    .replace("-", " - ");
}

function capitalize(text) {
  return text
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}


// =========================

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});