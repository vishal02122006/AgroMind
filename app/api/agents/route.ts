import { NextResponse } from "next/server";

export const runtime = "nodejs";

type FieldInput = {
  crop: string;
  district: string;
  soil: string;
  moisture: string;
  rain: string;
  issue: string;
  image?: string;
  specialist?: "Disease" | "Irrigation" | "Resources" | "Market";
};

type AgentResult = {
  agent: string;
  status: "ok" | "fallback";
  summary: string;
  confidence: number;
};

async function gemini(prompt: string, image?: string) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            ...(image?.startsWith("data:")
              ? [{
                  inlineData: {
                    mimeType: image.slice(5, image.indexOf(";")),
                    data: image.slice(image.indexOf(",") + 1),
                  },
                }]
              : []),
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
      }),
      cache: "no-store",
    },
  );
  if (!response.ok) return null;
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("") || null;
}

async function getWeather(district: string) {
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(district)}&count=1&countryCode=IN`,
      { cache: "no-store" },
    );
    if (!geo.ok) return null;
    const geoData = await geo.json();
    const place = geoData.results?.[0];
    if (!place) return null;
    const weather = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&daily=precipitation_probability_max&forecast_days=3&timezone=auto`,
      { cache: "no-store" },
    );
    if (!weather.ok) return null;
    const weatherData = await weather.json();
    return {
      name: "Open-Meteo weather forecast",
      probability: weatherData.daily?.precipitation_probability_max?.[0],
    };
  } catch {
    return null;
  }
}

async function getAuthorizedMarket(crop: string, district: string) {
  const key = process.env.DATA_GOV_IN_API_KEY;
  const resource =
    process.env.AGMARKNET_RESOURCE_ID ||
    "9ef84268-d588-465a-a308-a864a43d0070";
  if (!key) return null;
  try {
    const url =
      `https://api.data.gov.in/resource/${resource}?api-key=${encodeURIComponent(key)}&format=json` +
      `&filters[commodity]=${encodeURIComponent(crop)}&filters[district]=${encodeURIComponent(district)}&limit=10`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json();
    const records = data.records || [];
    const modalPrices = records
      .map((record: Record<string, unknown>) =>
        Number(record.modal_price ?? record.modalprice ?? record["Modal Price"]),
      )
      .filter((value: number) => Number.isFinite(value));
    const averageModal =
      modalPrices.length > 0
        ? modalPrices.reduce((sum: number, value: number) => sum + value, 0) / modalPrices.length
        : null;
    return {
      name: "data.gov.in - Current Daily Price of Various Commodities",
      recordCount: records.length,
      averageModal,
      latestDate:
        records[0]?.arrival_date ?? records[0]?.date ?? records[0]?.["Arrival Date"] ?? null,
      sourceUrl: `https://www.data.gov.in/resource/${resource}`,
    };
  } catch {
    return null;
  }
}

async function getProductionIndex(crop: string) {
  const url =
    process.env.AGRICULTURAL_INDEX_URL ||
    "https://www.data.gov.in/files/ogdpv2dms/s3fs-public/datafile/index_numbers_of_agricultural_production_and_productivity_2006-07_2009.csv";
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const text = await response.text();
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, "")))
      .filter((row) => row.length >= 3);
    const cropKey = crop.toLowerCase();
    const row =
      rows.find((item) => item[1].toLowerCase().includes(cropKey)) ||
      rows.find((item) => item[1].toLowerCase().includes("all crops"));
    if (!row) return null;
    return {
      name: "Index Numbers of Agricultural Production and Productivity",
      group: row[1],
      productionIndex: Number(row[2]),
      productivityIndex: Number(row[3]),
      sourceUrl: "https://www.data.gov.in/files/ogdpv2dms/s3fs-public/datafile/index_numbers_of_agricultural_production_and_productivity_2006-07_2009.csv",
    };
  } catch {
    return null;
  }
}

async function getSoilEvidence(district: string, soil: string) {
  const url = process.env.SOIL_HEALTH_API_URL;
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.SOIL_HEALTH_API_KEY
          ? { Authorization: `Bearer ${process.env.SOIL_HEALTH_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ district, soilType: soil }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return {
      name: "Government Soil Health Card evidence",
      data: await response.json(),
    };
  } catch {
    return null;
  }
}

async function getCropDiseaseEvidence(crop: string, district: string) {
  const url = process.env.KRISHI_DSS_API_URL;
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.KRISHI_DSS_API_KEY
          ? { Authorization: `Bearer ${process.env.KRISHI_DSS_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({ crop, district }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return {
      name: "Krishi DSS crop and disease-incidence evidence",
      data: await response.json(),
    };
  } catch {
    return null;
  }
}

function fallbackAgent(agent: string, detail: string): AgentResult {
  return { agent, status: "fallback", summary: detail, confidence: 55 };
}

export async function POST(request: Request) {
  let input: FieldInput;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const pythonApiUrl = process.env.AGROMIND_PYTHON_API_URL;
  if (pythonApiUrl) {
    try {
      const pythonResponse = await fetch(`${pythonApiUrl.replace(/\/$/, "")}/api/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        cache: "no-store",
      });
      if (pythonResponse.ok) {
        return NextResponse.json(await pythonResponse.json());
      }
    } catch {
      // The existing Node fallback remains available if the Python service is offline.
    }
  }

  const specialistOnly =
    input.specialist === "Disease" ||
    input.specialist === "Irrigation" ||
    input.specialist === "Resources" ||
    input.specialist === "Market";
  const weather =
    !specialistOnly || input.specialist === "Irrigation"
      ? await getWeather(input.district)
      : null;
  const market =
    !specialistOnly || input.specialist === "Market"
      ? await getAuthorizedMarket(input.crop, input.district)
      : null;
  const productionIndex =
    !specialistOnly || input.specialist === "Market"
      ? await getProductionIndex(input.crop)
      : null;
  const soilEvidence =
    !specialistOnly || input.specialist === "Resources"
      ? await getSoilEvidence(input.district, input.soil)
      : null;
  const diseaseEvidence =
    !specialistOnly || input.specialist === "Disease"
      ? await getCropDiseaseEvidence(input.crop, input.district)
      : null;

  const specialists = [
    {
      agent: "Disease",
      image: input.image,
      prompt: `You are the independent Disease Detection Agent. Use crop=${input.crop}, observed_issue=${input.issue}, district=${input.district}, district_disease_evidence=${JSON.stringify(diseaseEvidence?.data ?? "not connected")}. Respond in <=45 words. State likely causes, two checks, confidence, and escalation threshold. Do not prescribe pesticide doses.`,
      fallback: diseaseEvidence
        ? "Authorized disease-incidence evidence received; field confirmation still required"
        : input.image
          ? `Image received for ${input.crop}. Local symptom triage is ready: compare lesion shape, leaf side and spread pattern; isolate affected leaves and escalate uncertainty to a crop protection specialist.`
          : `Local ${input.crop} disease profile: assess lesion pattern, affected leaf age and spread; use multiple symptoms before a diagnosis and seek expert confirmation.`,
    },
    {
      agent: "Irrigation",
      prompt: `You are the independent Smart Irrigation Agent. Use crop=${input.crop}, soil=${input.soil}, moisture=${input.moisture}%, forecast_rain=${input.rain}mm, weather_probability=${weather?.probability ?? "unknown"}. Respond in <=45 words. Give one evidence-based scheduling action and one root-zone check. Never operate pump hardware automatically.`,
      fallback: weather
        ? `District forecast context is available. With ${input.moisture}% moisture and ${input.rain}mm rain, verify root-zone moisture before release.`
        : Number(input.moisture) < 30
          ? "Low soil moisture: verify a 10-15 cm root-zone reading before a measured irrigation decision."
          : "Forecast unavailable: verify soil moisture and rainfall locally before irrigation.",
    },
    {
      agent: "Resources",
      prompt: `You are the independent Resource Optimization Agent. Use crop=${input.crop}, soil=${input.soil}, district=${input.district}, soil_health_evidence=${JSON.stringify(soilEvidence?.data ?? "not connected")}. Respond in <=45 words. Recommend only a soil-lab workflow and general nutrient categories. Never invent NPK doses.`,
      fallback: soilEvidence
        ? "Authorized soil evidence received; verify field-specific lab values"
        : `For ${input.soil} soil, request an accredited soil test for pH and NPK before amendment; do not apply invented doses.`,
    },
    {
      agent: "Market",
      prompt: `You are a market-timing specialist. Given crop=${input.crop}, district=${input.district}, authorized_mandi_record_count=${market?.recordCount ?? "unavailable"}, average_mandi_modal_price=${market?.averageModal ?? "unavailable"}, production_index=${productionIndex?.productionIndex ?? "unavailable"}, productivity_index=${productionIndex?.productivityIndex ?? "unavailable"}, respond in <=45 words. Explain the evidence before harvest or sale timing; do not invent prices or guarantees.`,
      fallback: market
        ? `${market.recordCount} authorized mandi records found; averages need review`
        : `No live mandi feed is configured for ${input.crop} in ${input.district}. Delay sale timing advice until arrival, variety and district records are verified.`,
    },
  ];

  const selectedSpecialists = input.specialist
    ? specialists.filter((specialist) => specialist.agent === input.specialist)
    : specialists;

  const agents: AgentResult[] = [];
  for (const specialist of selectedSpecialists) {
    const text = await gemini(specialist.prompt, specialist.image);
    agents.push(
      text
        ? { agent: specialist.agent, status: "ok", summary: text, confidence: 72 }
        : fallbackAgent(specialist.agent, specialist.fallback),
    );
  }

  let plan: string[];
  if (specialistOnly) {
    plan = [
      `${input.specialist} specialist result is shown above. Run full collaboration for a coordinated plan.`,
    ];
  } else {
    const orchestratorPrompt =
      `You are the central agricultural orchestrator. Reconcile these specialist outputs and produce 3 concise actions and 1 warning: ` +
      agents.map((agent) => `${agent.agent}: ${agent.summary}`).join("; ") +
      `. Return plain text only. Require local agronomist, soil lab, and farmer approval where consequential.`;
    const orchestratorText = await gemini(orchestratorPrompt);
    plan = orchestratorText
      ? orchestratorText.split(/\n|(?<=\.)\s+/).map((line: string) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 4)
      : [
          `${input.crop} disease review: compare symptoms across several leaves, capture growth stage and seek local confirmation before treatment.`,
          Number(input.moisture) < 30
            ? `Irrigation review: verify the root-zone moisture reading before release; rain forecast is ${input.rain}mm.`
            : `Irrigation review: current moisture is ${input.moisture}% and rain forecast is ${input.rain}mm; verify locally before release.`,
          "Resource review: obtain a recent soil test for pH and NPK; do not apply an invented fertilizer dose.",
          `Market review: verify ${input.crop} variety, district mandi arrival and modal price before harvest or sale timing.`,
        ];
  }

  const sources: { name: string; status: "authorized" | "illustrative"; url?: string }[] = [
    weather
      ? { name: weather.name, status: "authorized", url: "https://open-meteo.com/" }
      : { name: "District weather", status: "illustrative", url: "https://open-meteo.com/" },
    diseaseEvidence
      ? { name: diseaseEvidence.name, status: "authorized", url: "https://krishi-dss.gov.in/" }
      : { name: "Krishi DSS disease-incidence evidence", status: "illustrative", url: "https://krishi-dss.gov.in/" },
    soilEvidence
      ? { name: soilEvidence.name, status: "authorized", url: "https://soilhealth.dac.gov.in/" }
      : { name: "Government Soil Health Card evidence", status: "illustrative", url: "https://soilhealth.dac.gov.in/" },
    market
      ? { name: market.name, status: "authorized", url: market.sourceUrl }
      : { name: "Agmarknet variety-wise daily prices", status: "illustrative", url: "https://www.data.gov.in/" },
    productionIndex
      ? { name: productionIndex.name, status: "authorized", url: productionIndex.sourceUrl }
      : { name: "Agricultural production and productivity index", status: "illustrative", url: "https://www.data.gov.in/" },
  ];
  const sourcesForSpecialist =
    input.specialist === "Disease"
      ? [sources[1]]
      : input.specialist === "Irrigation"
        ? [sources[0]]
        : input.specialist === "Resources"
          ? [sources[2]]
          : input.specialist === "Market"
            ? [sources[3], sources[4]]
            : sources;

  return NextResponse.json({
    plan,
    warnings: [
      "No treatment, irrigation release, or fertilizer dose is applied automatically.",
      "Local agronomic verification is required before consequential action.",
      ...(specialistOnly
        ? [`Only the ${input.specialist} specialist ran; cross-agent orchestration was skipped.`]
        : []),
    ],
    agents,
    sources: sourcesForSpecialist,
    evidence: {
      weather: weather
        ? { name: weather.name, probability: weather.probability }
        : null,
      disease: diseaseEvidence
        ? { name: diseaseEvidence.name, connected: true }
        : null,
      soil: soilEvidence
        ? { name: soilEvidence.name, connected: true }
        : null,
      market: market
        ? {
            recordCount: market.recordCount,
            averageModal: market.averageModal,
            latestDate: market.latestDate,
            sourceUrl: market.sourceUrl,
          }
        : null,
      productionIndex,
    },
  });
}
