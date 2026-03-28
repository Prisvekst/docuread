import express from "express";
import multer from "multer";
import fs from "fs";
import dotenv from "dotenv";
import OpenAI, { toFile } from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const klient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  dest: "uploads/",
});

/** Stabil JSON-nøkkelrekkefølge */
const OUTPUT_KEY_ORDER = [
  "navn",
  "adresse",
  "periode",
  "fakturadato",
  "leverandør",
  "prisområde",
  "målernummer",
  "målepunkt_id",
  "avtalenavn",
  "påslag",
  "fastbeløp",
  "strømpris",
  "totale_kostnader",
  "tilleggstjenester",
  "årsforbruk",
  "periodeforbruk",
];

function sorterNøkler(obj, nøkler) {
  const resultat = {};

  for (const nøkkel of nøkler) {
    if (Object.prototype.hasOwnProperty.call(obj, nøkkel)) {
      resultat[nøkkel] = obj[nøkkel];
    }
  }

  return resultat;
}

/** Total tokens from OpenAI Responses `usage` (snake_case or camelCase). */
function hentTotaltAntallTokens(response) {
  const u = response?.usage;
  if (!u || typeof u !== "object") {
    return null;
  }

  const inputTokens =
    u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens;
  const outputTokens =
    u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens;
  let totalTokens = u.total_tokens ?? u.totalTokens;
  if (totalTokens == null && typeof inputTokens === "number" && typeof outputTokens === "number") {
    totalTokens = inputTokens + outputTokens;
  }

  return typeof totalTokens === "number" && !Number.isNaN(totalTokens) ? totalTokens : null;
}

app.use(express.json());

app.post("/parse-invoice", upload.single("file"), async (req, res) => {
  let filsti = req.file.path;

  try {
    const buffer = fs.readFileSync(filsti);

    const fil = await klient.files.create({
      file: await toFile(buffer, req.file.originalname),
      purpose: "user_data",
    });

    const systemPrompt = `
Du er en ekspert på å lese norske strømfakturaer.

Returner KUN gyldig JSON.

------------------------
GENERELLE REGLER
------------------------
- Ikke gjett verdier
- Hvis en verdi mangler → returner null
- Velg den mest korrekte verdien når flere finnes

------------------------
FORMATERINGSREGLER
------------------------
Datoer:
- Format: DD.MM.YYYY

Perioder:
- Format: "DD.MM.YYYY - DD.MM.YYYY"
- Konverter:
  "hele april 2025" → "01.04.2025 - 30.04.2025"

Tall:
- Bruk punktum som desimalskilletegn

------------------------
FELTDEFINISJONER
------------------------
strømpris:
- Pris per kWh (øre/kWh)
- Bruk kun verdier merket "øre/kWh"
- Feltet er ofte kalt strømpris, spotpris, fastpris, strøm og lignende.

påslag:
- Tilleggskostnad per kWh (øre/kWh)
- Bruk kun verdier merket "øre/kWh"

fastbeløp:
- Månedlig fastbeløp (kr/mnd)
- Feltet er ofte kalt fastbeløp, abonnement lignende.

totale_kostnader:
- en strømregning består i noen tilfeller av strømregning og nettleie regning, du skal ignorere nettleie og finne ut av summen av strømregningen.
- strømregningen er som regel det største beløpet på regningen utenom nettleien som vi ignorerer.
- Finn summen av alle postene i strømregningen.

målepunkt_id:
- Målepunkt-ID
- Numerisk streng
- Starter alltid med 7070575000
- Vanligvis 18 sifre
- Ikke forveksle med målernummer

------------------------
TILLEGGSTJENESTER
------------------------
- Inkluder KUN tjenester som ikke allerede finnes i andre felt
- Ekskluder abonnement, fastbeløp og påslag

- Format:
  "Tjenestenavn (verdi enhet)"

- Eksempel:
  "Papirfaktura (8.32 kr)"
  "Garantistrøm (9.9 øre/kWh)"

- Hvis ingen → null

------------------------
SLUTTRESULTAT
------------------------
Returner KUN JSON som matcher skjemaet.
`;

    const schema = {
      type: "json_schema",
      name: "faktura",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          navn: { type: ["string", "null"] },
          adresse: { type: ["string", "null"] },
          periode: { type: ["string", "null"] },
          fakturadato: { type: ["string", "null"] },
          leverandør: { type: ["string", "null"] },
          prisområde: { type: ["string", "null"] },
          målernummer: { type: ["string", "null"] },
          målepunkt_id: { type: ["string", "null"] },
          avtalenavn: { type: ["string", "null"] },
          påslag: { type: ["number", "null"] },
          fastbeløp: { type: ["number", "null"] },
          strømpris: { type: ["number", "null"] },
          totale_kostnader: { type: ["number", "null"] },
          tilleggstjenester: {
            type: ["array", "null"],
            items: { type: "string" },
          },
          årsforbruk: { type: ["number", "null"] },
          periodeforbruk: { type: ["number", "null"] },
          manglende_felt: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: [
          "navn",
          "adresse",
          "periode",
          "fakturadato",
          "leverandør",
          "prisområde",
          "målernummer",
          "målepunkt_id",
          "avtalenavn",
          "påslag",
          "fastbeløp",
          "strømpris",
          "totale_kostnader",
          "tilleggstjenester",
          "årsforbruk",
          "periodeforbruk",
          "manglende_felt",
        ],
      },
    };

    const response = await klient.responses.create({
      model: "gpt-4o",
      temperature: 0,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }],
        },
        {
          role: "user",
          content: [{ type: "input_file", file_id: fil.id }],
        },
      ],
      text: {
        format: schema,
      },
    });

    const parsed = JSON.parse(response.output_text);
    const formatert = formaterOutput(parsed);
    const faktura = sorterNøkler(formatert, OUTPUT_KEY_ORDER);

    return res.json({
      ...faktura,
      tokens: hentTotaltAntallTokens(response),
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message,
    });
  } finally {
    if (fs.existsSync(filsti)) {
      fs.unlinkSync(filsti);
    }
  }
});

function formaterOutput(data) {
  return {
    navn: data.navn,
    adresse: formaterAdresse(data.adresse),
    periode: formaterPeriode(data.periode),
    fakturadato: data.fakturadato,
    leverandør: data.leverandør,
    prisområde: data.prisområde,
    målernummer: data.målernummer,
    målepunkt_id: data.målepunkt_id,
    avtalenavn: data.avtalenavn,
    påslag: formaterVerdi(data.påslag, "øre/kWh"),
    fastbeløp: formaterVerdi(data.fastbeløp, "kr/mnd"),
    strømpris: formaterVerdi(data.strømpris, "øre/kWh"),
    totale_kostnader: formaterValuta(data.totale_kostnader),
    tilleggstjenester: formaterTjenester(data.tilleggstjenester),
    årsforbruk: formaterVerdi(data.årsforbruk, "kWh"),
    periodeforbruk: formaterVerdi(data.periodeforbruk, "kWh"),
  };
}

function formaterVerdi(verdi, enhet) {
  if (verdi == null) {
    return null;
  }

  return `${avrund(verdi)} ${enhet}`;
}

function formaterValuta(verdi) {
  if (verdi == null) {
    return null;
  }

  return `${verdi.toLocaleString("nb-NO")} kr`;
}

function formaterTjenester(tjenester) {
  if (!tjenester || !tjenester.length) {
    return null;
  }

  return tjenester.join(", ");
}

function formaterPeriode(periode) {
  if (!periode) {
    return null;
  }

  return periode.replace(/\s*-\s*/, " - ");
}

function formaterAdresse(adresse) {
  if (!adresse) {
    return null;
  }

  return adresse
    .toLowerCase()
    .split(" ")
    .map((ord) => {
      if (/^\d+[a-z]$/i.test(ord)) {
        return ord.toUpperCase();
      }

      return ord.charAt(0).toUpperCase() + ord.slice(1);
    })
    .join(" ");
}

function avrund(tall) {
  return Math.round(tall * 100) / 100;
}

app.listen(port, () => {
  console.log(`Server kjører på port ${port}`);
});