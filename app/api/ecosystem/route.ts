import { NextResponse } from "next/server";

export async function GET() {
  const pythonApiUrl = process.env.AGROMIND_PYTHON_API_URL;
  if (pythonApiUrl) {
    try {
      const response = await fetch(
        `${pythonApiUrl.replace(/\/$/, "")}/api/ecosystem`,
        { cache: "no-store" },
      );
      if (response.ok) return NextResponse.json(await response.json());
      console.warn("Python ecosystem request failed", response.status);
    } catch (error) {
      console.warn(
        "Python ecosystem request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
  }

  return NextResponse.json({
    orchestrator: {
      name: "Central Orchestrator",
      role: "Reconciles specialist evidence and detects conflicts",
      humanApprovalRequired: true,
    },
    agents: [
      { name: "Disease", domain: "disease", authorizedSources: ["Krishi DSS"], status: process.env.KRISHI_DSS_API_URL ? "configured" : "not_configured" },
      { name: "Irrigation", domain: "weather", authorizedSources: ["Open-Meteo"], status: "public" },
      { name: "Resources", domain: "soil", authorizedSources: ["Soil Health Card"], status: process.env.SOIL_HEALTH_API_URL ? "configured" : "not_configured" },
      { name: "Market", domain: "market", authorizedSources: ["data.gov.in", "AGMARKNET", "Agricultural indices"], status: process.env.DATA_GOV_IN_API_KEY ? "configured" : "not_configured" },
    ],
  });
}
