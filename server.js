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
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
  fileFilter: (req, file, cb) => {
    if (!allowedMimeTypes.includes(file.mimetype)) {
      return cb(new Error("Kun PDF, PNG, JPG/JPEG og WEBP er tillatt."));
    }
    cb(null, true);
  },
});

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Strømfaktura parser API kjører",
  });
});

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let uploadedPath = null;

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "OPENAI_API_KEY mangler i .env",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Ingen fil lastet opp. Bruk form-data med nøkkel "file".',
      });
    }

    uploadedPath = req.file.path;

    // Les temp-filen og send den videre til OpenAI
    // med originalt filnavn + MIME-type
    const fileBuffer = fs.readFileSync(uploadedPath);

    const openaiFile = await client.files.create({
      file: await toFile(fileBuffer, req.file.originalname, {
        type: req.file.mimetype,
      }),
      purpose: "user_data",
    });

    const response = await client.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
Du skal lese en norsk strømfaktura og returnere strukturert JSON.

Regler:
- Returner kun feltene i schemaet.
- Bruk null hvis verdien mangler eller ikke kan leses tydelig.
- Ikke gjett.
- Behold norske navn og tekstverdier slik de står i dokumentet når det passer.
- Konverter dato til YYYY-MM-DD hvis datoen er tydelig.
- Konverter beløp til tall uten "kr".
- Konverter øre/kWh til tall, for eksempel "6,25 øre/kWh" -> 6.25
- Konverter kWh til tall uten enhet.
- Hvis strømforbruk år er oppgitt som estimert, sett stromforbruk_ar_estimert til true.
- "tilleggstjenester" skal være en tekstliste. Hvis ingen finnes, returner [].
- "sum_strom_kr" skal være total strømkostnad hvis den fremgår tydelig av fakturaen.
- Hvis et felt ikke finnes, legg feltnavnet i missing_fields.
              `.trim(),
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
        format: {
          type: "json_schema",
          name: "stromfaktura_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              navn: { type: ["string", "null"] },
              adresse: { type: ["string", "null"] },
              leverandor: { type: ["string", "null"] },
              dato: { type: ["string", "null"] },

              stromforbruk_ar_kwh: { type: ["number", "null"] },
              stromforbruk_ar_estimert: { type: ["boolean", "null"] },

              malernummer: { type: ["string", "null"] },
              avtale_navn: { type: ["string", "null"] },
              prisomrade: { type: ["string", "null"] },

              paslag_ore_per_kwh: { type: ["number", "null"] },
              fastbelop_per_maned_kr: { type: ["number", "null"] },

              stromforbruk_periode_kwh: { type: ["number", "null"] },
              strompris_ore_per_kwh: { type: ["number", "null"] },

              tilleggstjenester: {
                type: "array",
                items: { type: "string" },
              },

              sum_strom_kr: { type: ["number", "null"] },

              missing_fields: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: [
              "navn",
              "adresse",
              "leverandor",
              "dato",
              "stromforbruk_ar_kwh",
              "stromforbruk_ar_estimert",
              "malernummer",
              "avtale_navn",
              "prisomrade",
              "paslag_ore_per_kwh",
              "fastbelop_per_maned_kr",
              "stromforbruk_periode_kwh",
              "strompris_ore_per_kwh",
              "tilleggstjenester",
              "sum_strom_kr",
              "missing_fields",
            ],
          },
        },
      },
    });

    let parsed;

    try {
      parsed = JSON.parse(response.output_text);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Kunne ikke parse JSON fra OpenAI-responsen.",
        raw_output: response.output_text || null,
      });
    }

    return res.json({
      success: true,
      filename: req.file.originalname,
      mime_type: req.file.mimetype,
      data: parsed,
    });
  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || "Ukjent serverfeil",
    });
  } finally {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try {
        fs.unlinkSync(uploadedPath);
      } catch (cleanupError) {
        console.error("Kunne ikke slette temp-fil:", cleanupError.message);
      }
    }
  }
});

app.use((err, req, res, next) => {
  return res.status(400).json({
    success: false,
    error: err.message || "Feil ved filopplasting",
  });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});