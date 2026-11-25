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
    } catch {
      // Return the repository-level fallback registry below.
    }
  }

  return NextResponse.json({
    orchestrator: {
      name: "Central Orchestrator",
      role: "Reconciles specialist evidence and detects conflicts",
      humanApprovalRequired: true,
    },
    agents: [
      { name: "Disease", domain: "disease", authorizedSources: ["Krishi DSS"], status: "fallback" },
      { name: "Irrigation", domain: "weather", authorizedSources: ["Open-Meteo"], status: "connected" },
      { name: "Resources", domain: "soil", authorizedSources: ["Soil Health Card"], status: "fallback" },
      { name: "Market", domain: "market", authorizedSources: ["data.gov.in", "AGMARKNET", "Agricultural indices"], status: "fallback" },
    ],
  });
}
