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

    const systemPrompt = `
You will read a Norwegian electricity invoice and return structured JSON.

Rules:
- Return only the fields in the schema.
- Use null if the value is missing or cannot be read clearly.
- Do not guess.
- Keep Norwegian names and text values as they appear in the document when appropriate.
- Convert dates to YYYY-MM-DD when the date is clear.
- Convert amounts to numbers without "kr".
- Period should be a from and to date, for example "01.01.26 - 01.02.26".
- Convert kWh to numbers without units.
- If annual electricity consumption is stated as estimated, set annual_consumption_estimated to true.
- "additional_services" must be a list of strings, including the price of the service. If none exist, return [].
- "total_costs" should be total electricity cost if it clearly appears on the invoice.
- If a field is not found, add the field name to missing_fields.
- Price area should only contain 3 characters, for example NO1, NO2, NO3, NO4.
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
          date: { type: ["string", "null"] },

          annual_consumption: { type: ["number", "null"] },
          annual_consumption_estimated: { type: ["boolean", "null"] },

          meter_number: { type: ["string", "null"] },
          agreement_name: { type: ["string", "null"] },
          price_area: { type: ["string", "null"] },

          surcharge: { type: ["number", "null"] },
          fixed_cost: { type: ["number", "null"] },

          period: { type: ["number", "null"] },
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
          "date",
          "annual_consumption",
          "annual_consumption_estimated",
          "meter_number",
          "agreement_name",
          "price_area",
          "surcharge",
          "fixed_cost",
          "period",
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
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPrompt,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_file",
                file_id: openaiFile.id,
              },
            ],
          },
        ],
        text: {
          format: schema,
        },
      });
    } else {
      const imageBuffer = fs.readFileSync(uploadedPath);
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

      response = await client.responses.create({
        model: "gpt-4o",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPrompt,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: dataUrl,
              },
            ],
          },
        ],
        text: {
          format: schema,
        },
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
