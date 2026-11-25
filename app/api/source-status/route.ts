import { NextResponse } from "next/server";

export async function GET() {
  const pythonApiUrl = process.env.AGROMIND_PYTHON_API_URL;
  if (pythonApiUrl) {
    try {
      const response = await fetch(
        `${pythonApiUrl.replace(/\/$/, "")}/api/source-status`,
        { cache: "no-store" },
      );
      if (response.ok) return NextResponse.json(await response.json());
      console.warn("Python source-status request failed", response.status);
    } catch (error) {
      console.warn(
        "Python source-status request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  return NextResponse.json({
    sources: [
      { name: "Open-Meteo", category: "Weather", url: "https://open-meteo.com/", connect: "Public API", status: "public" },
      { name: "data.gov.in", category: "Mandi and production", url: "https://www.data.gov.in/", connect: "Requires API key", status: process.env.DATA_GOV_IN_API_KEY ? "configured" : "not_configured" },
      { name: "AGMARKNET", category: "Daily mandi prices", url: "https://agmarknet.gov.in/", connect: "Via authorized data.gov.in resource", status: process.env.DATA_GOV_IN_API_KEY ? "configured" : "not_configured" },
      { name: "Krishi DSS", category: "Crop and disease context", url: "https://krishi-dss.gov.in/", connect: "Requires configured project endpoint", status: process.env.KRISHI_DSS_API_URL ? "configured" : "not_configured" },
      { name: "Soil Health Card", category: "Soil and nutrient evidence", url: "https://soilhealth.dac.gov.in/", connect: "Requires configured authorized API", status: process.env.SOIL_HEALTH_API_URL ? "configured" : "not_configured" },
    ],
  });
}
