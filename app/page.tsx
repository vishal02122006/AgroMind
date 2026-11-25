"use client";

import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { supabase } from "./lib/supabase";

type View = "overview" | "disease" | "field" | "collaboration" | "evidence" | "assistant";
type AgentResult = { agent: string; status: "idle" | "ok" | "fallback"; summary: string; confidence: number | null };
type RunResult = {
  plan: string[];
  warnings: string[];
  orchestratorRan?: boolean | null;
  agents: AgentResult[];
  sources: { name: string; status: "authorized" | "illustrative"; url?: string }[];
};

const emptyResult: RunResult = {
  plan: ["Select a field scenario or upload a crop image to begin."],
  warnings: ["No action is executed automatically."],
  orchestratorRan: null,
  agents: [
    { agent: "Disease", status: "idle", summary: "Upload a crop image or describe symptoms to analyze.", confidence: null },
    { agent: "Irrigation", status: "idle", summary: "Set moisture and rainfall to review water timing.", confidence: null },
    { agent: "Resources", status: "idle", summary: "Add soil and district context for nutrient review.", confidence: null },
    { agent: "Market", status: "idle", summary: "Select crop and district to review market context.", confidence: null },
  ],
  sources: [{ name: "No source request has run", status: "illustrative" }],
};

export default function Home() {
  const [theme, setTheme] = useState<"green" | "black">("green");
  const [language, setLanguage] = useState<"English" | "हिन्दी" | "తెలుగు">("English");
  const [sessionStarted, setSessionStarted] = useState(false);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(false);
  const [activeAgent, setActiveAgent] = useState("Disease");
  const [result, setResult] = useState(emptyResult);
  const [imagePreview, setImagePreview] = useState("");
  const [imageData, setImageData] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Ask about this field, a symptom, irrigation, soil or a mandi." },
  ]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatPosition, setChatPosition] = useState<{ x: number; y: number } | null>(null);
  const chatDrag = useRef<{ active: boolean; dx: number; dy: number }>({
    active: false,
    dx: 0,
    dy: 0,
  });
  const [form, setForm] = useState({
    crop: "Tomato",
    district: "Anantapur",
    soil: "Red sandy loam",
    moisture: "22",
    rain: "18",
    issue: "Yellow-brown spots on lower leaves",
  });

  useEffect(() => {
    setTheme(localStorage.getItem("agromind_theme") === "black" ? "black" : "green");
    const savedLanguage = localStorage.getItem("agromind_language");
    if (savedLanguage === "हिन्दी" || savedLanguage === "తెలుగు" || savedLanguage === "English") {
      setLanguage(savedLanguage);
    }
    if (!supabase) {
      setLoginError("Authentication is not configured.");
      return;
    }
    supabase.auth.getSession().then(({ data }) => setSessionStarted(Boolean(data.session)));
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setSessionStarted(Boolean(session)));
    return () => data.subscription.unsubscribe();
  }, []);

  function toggleTheme() {
    const next = theme === "green" ? "black" : "green";
    setTheme(next);
    localStorage.setItem("agromind_theme", next);
  }

  function changeLanguage(next: "English" | "हिन्दी" | "తెలుగు") {
    setLanguage(next);
    localStorage.setItem("agromind_language", next);
  }

  async function enterSession(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return setLoginError("Authentication is not configured.");
    if (!loginEmail.trim() || loginPassword.length < 8) {
      setLoginError("Enter a valid email and a password with at least 8 characters.");
      return;
    }
    setAuthBusy(true);
    setLoginError("");
    const response = authMode === "sign-up"
      ? await supabase.auth.signUp({ email: loginEmail.trim(), password: loginPassword, options: { emailRedirectTo: window.location.origin } })
      : await supabase.auth.signInWithPassword({ email: loginEmail.trim(), password: loginPassword });
    setAuthBusy(false);
    if (response.error) return setLoginError(response.error.message);
    if (authMode === "sign-up" && !response.data.session) {
      setLoginError("Account created. Confirm your email, then sign in.");
      setAuthMode("sign-in");
      return;
    }
    setSessionStarted(Boolean(response.data.session));
  }

  async function logout() {
    await supabase?.auth.signOut();
    setSessionStarted(false);
  }

  function update(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function applyScenario(type: "tomato" | "rice" | "maize") {
    const scenarios = {
      tomato: { crop: "Tomato", district: "Anantapur", soil: "Red sandy loam", moisture: "22", rain: "18", issue: "Yellow-brown spots on lower leaves" },
      rice: { crop: "Rice", district: "Thanjavur", soil: "Clay", moisture: "48", rain: "30", issue: "Leaf discoloration after heavy rain" },
      maize: { crop: "Maize", district: "Indore", soil: "Black cotton soil", moisture: "36", rain: "8", issue: "No visible disease symptoms" },
    };
    setForm(scenarios[type]);
  }

  function selectImage(file?: File) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > 8 * 1024 * 1024) {
      setLoginError("Image must be smaller than 8 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      setImageData(value);
      setImagePreview(value);
    };
    reader.readAsDataURL(file);
  }

  async function runAgents(event?: FormEvent) {
    event?.preventDefault();
    setLoading(true);
    setView("collaboration");
    setActiveAgent("Disease");
    const sequence = ["Disease", "Irrigation", "Resources", "Market", "Orchestrator"];
    let index = 0;
    const timer = window.setInterval(() => {
      index = Math.min(index + 1, sequence.length - 1);
      setActiveAgent(sequence[index]);
    }, 450);
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, image: imageData }),
      });
      if (!response.ok) throw new Error("Agent service unavailable");
      setResult(await response.json());
      setActiveAgent("Orchestrator");
    } catch {
      setResult({
        ...emptyResult,
        warnings: ["The agent service could not be reached. No simulated decision is shown."],
      });
    } finally {
      window.clearInterval(timer);
      setLoading(false);
    }
  }

  async function runSpecialist(agentName: "Disease" | "Irrigation" | "Resources" | "Market") {
    setLoading(true);
    setActiveAgent(agentName);
    setView("collaboration");
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, image: imageData, specialist: agentName }),
      });
      if (!response.ok) throw new Error("Agent service unavailable");
      const data: RunResult = await response.json();
      setResult((current) => ({
        ...data,
        agents: current.agents.map((agent) =>
          agent.agent === agentName
            ? data.agents.find((item) => item.agent === agentName) || agent
            : agent,
        ),
      }));
    } catch {
      setResult((current) => ({
        ...current,
        warnings: ["The selected agent could not be reached. No action was simulated."],
      }));
    } finally {
      setLoading(false);
    }
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    setChatInput("");
    setChatMessages((current) => [...current, { role: "user", text: message }]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, field: form }),
      });
      const data = await response.json();
      setChatMessages((current) => [...current, { role: "assistant", text: data.reply || "No verified response was available." }]);
    } catch {
      setChatMessages((current) => [...current, { role: "assistant", text: "The assistant could not connect." }]);
    }
  }

  function startChatDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = event.currentTarget.closest(".floating-chat") as HTMLDivElement | null;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    chatDrag.current = {
      active: true,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveChatDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!chatDrag.current.active) return;
    const panelWidth = 380;
    const panelHeight = 520;
    const x = Math.max(8, Math.min(window.innerWidth - panelWidth - 8, event.clientX - chatDrag.current.dx));
    const y = Math.max(8, Math.min(window.innerHeight - panelHeight - 8, event.clientY - chatDrag.current.dy));
    setChatPosition({ x, y });
  }

  function stopChatDrag(event: ReactPointerEvent<HTMLDivElement>) {
    chatDrag.current.active = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function renderFloatingChat() {
    const positionStyle = chatPosition
      ? { left: `${chatPosition.x}px`, top: `${chatPosition.y}px`, bottom: "auto", right: "auto" }
      : undefined;
    return chatOpen ? (
      <aside
        className="floating-chat"
        style={positionStyle}
        aria-label="Movable AgroMind AI assistant"
      >
        <header
          className="floating-chat-header"
          onPointerDown={startChatDrag}
          onPointerMove={moveChatDrag}
          onPointerUp={stopChatDrag}
        >
          <div><span className="chat-avatar">AM</span><div><strong>AgroMind Assistant</strong><small>Live agricultural copilot</small></div></div>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setChatOpen(false)} aria-label="Close assistant">×</button>
        </header>
        <div className="floating-chat-messages">
          {chatMessages.map((message, index) => (
            <div className={`chat-message ${message.role}`} key={index}>{message.text}</div>
          ))}
        </div>
        <form className="floating-chat-form" onSubmit={sendChat}>
          <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask about your field..." />
          <button type="submit" aria-label="Send message">↗</button>
        </form>
      </aside>
    ) : (
      <button className="floating-chat-launcher" type="button" onClick={() => setChatOpen(true)}>
        <span>✦</span><strong>Ask AgroMind</strong>
      </button>
    );
  }

  if (!sessionStarted) {
    return (
      <main className={`landing-shell ${theme === "black" ? "premium-black" : ""}`}>
        <nav className="landing-nav" id="landing-home">
          <button className="landing-brand" type="button" onClick={() => document.querySelector("#landing-home")?.scrollIntoView()}><span>AM</span><strong>AgroMind AI</strong></button>
          <div className="landing-links">
            <button type="button" onClick={() => document.querySelector("#landing-home")?.scrollIntoView()}>Home</button>
            <button type="button" onClick={() => document.querySelector("#landing-services")?.scrollIntoView()}>Features</button>
            <button type="button" onClick={() => document.querySelector("#landing-agents")?.scrollIntoView()}>AI Agents</button>
            <button type="button" onClick={() => document.querySelector("#landing-how")?.scrollIntoView()}>How It Works</button>
            <button type="button" onClick={() => document.querySelector("#landing-food")?.scrollIntoView()}>Food Security</button>
            <button type="button" onClick={() => document.querySelector("#landing-about")?.scrollIntoView()}>About Us</button>
          </div>
          <div className="landing-actions">
            <select
              className="language-select"
              value={language}
              onChange={(event) => changeLanguage(event.target.value as "English" | "हिन्दी" | "తెలుగు")}
              aria-label="Choose language"
            >
              <option>English</option>
              <option>हिन्दी</option>
              <option>తెలుగు</option>
            </select>
            <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label="Switch premium theme">
              {theme === "black" ? "Light" : "Black"}
            </button>
            <button className="landing-login-secondary" type="button" onClick={() => document.querySelector("#landing-auth")?.scrollIntoView()}>Login</button>
            <button className="landing-login" type="button" onClick={() => document.querySelector("#landing-auth")?.scrollIntoView()}>Get Started <span>→</span></button>
          </div>
        </nav>
        <section className="landing-hero">
          <div className="landing-shade" />
          <div className="landing-hero-content">
            <div>
              <span className="landing-eyebrow"><i />Intelligent agriculture platform</span>
              <h1>Smarter decisions<br />for every field.</h1>
              <div className="landing-bottom">
                <article className="landing-feature">
                  <span>01</span>
                  <strong>Farm intelligence</strong>
                  <small>Crop health, irrigation, soil and market signals</small>
                </article>
                <article className="landing-copy">
                  <p>Five specialized agents coordinate evidence and produce a reviewed, unified field plan.</p>
                  <button type="button" onClick={() => document.querySelector("#landing-auth")?.scrollIntoView()}>Get started <span>→</span></button>
                </article>
              </div>
            </div>
          </div>
        </section>
        <section className="landing-services" id="landing-services">
          <article id="landing-agents"><span>Disease</span><strong>Crop vision</strong><small>Leaf symptoms and escalation</small></article>
          <article><span>Irrigation</span><strong>Water planning</strong><small>Moisture and forecast review</small></article>
          <article><span>Resources</span><strong>Soil guidance</strong><small>Lab-first nutrient planning</small></article>
          <article id="landing-about"><span>Market</span><strong>Mandi context</strong><small>Harvest and price evidence</small></article>
        </section>
        <section className="landing-how" id="landing-how">
          <article><span>01</span><strong>Submit field data</strong><small>Crop, district, soil and observed symptoms</small></article>
          <article><span>02</span><strong>Agents analyze</strong><small>Each specialist reviews its own evidence</small></article>
          <article><span>03</span><strong>Orchestrator reconciles</strong><small>Conflicts and risks are identified</small></article>
          <article><span>04</span><strong>Farmer remains in control</strong><small>Review, approve and track locally</small></article>
        </section>
        <section className="landing-food" id="landing-food">
          <span>Food Security</span>
          <h2>Community insights with farmer privacy.</h2>
          <p>Regional crop availability and production context support cooperatives without exposing individual parcel data.</p>
        </section>
        <section className="landing-auth" id="landing-auth">
          <form className="login-form" onSubmit={enterSession}>
            <span className="eyebrow">Secure workspace</span>
            <h2>{authMode === "sign-up" ? "Create account" : "Welcome back"}</h2>
            <label>Email address<input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} /></label>
            <label>Password<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} /></label>
            {loginError && <p className="login-error">{loginError}</p>}
            <button className="primary login-submit" disabled={authBusy}>{authBusy ? "Please wait..." : authMode === "sign-up" ? "Create account" : "Sign in securely"}</button>
            <button type="button" className="auth-mode-button" onClick={() => setAuthMode(authMode === "sign-up" ? "sign-in" : "sign-up")}>{authMode === "sign-up" ? "Already registered? Sign in" : "New here? Create an account"}</button>
          </form>
        </section>
        {renderFloatingChat()}
      </main>
    );
  }

  const navItems: { id: View; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "⌂" },
    { id: "disease", label: "Disease Scan", icon: "◉" },
    { id: "field", label: "Field Analysis", icon: "▦" },
    { id: "collaboration", label: "Agent Collaboration", icon: "◎" },
    { id: "evidence", label: "Agent Knowledge", icon: "✓" },
    { id: "assistant", label: "AI Assistant", icon: "✦" },
  ];

  return (
    <main className={`dashboard-shell ${theme === "black" ? "premium-black" : ""}`}>
      <aside className="dashboard-sidebar">
        <div className="dashboard-brand"><span className="brandmark">AM</span><strong>AgroMind</strong></div>
        <nav>
          {navItems.map((item) => (
            <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>
              <span>{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <button className="logout-button" onClick={logout}>Sign out</button>
      </aside>

      <section className="dashboard-content">
        <header className="dashboard-header">
          <div><span className="eyebrow">AgroMind workspace</span><h1>{navItems.find((item) => item.id === view)?.label}</h1></div>
          <div className="dashboard-header-actions">
            <select
              className="language-select-dashboard"
              value={language}
              onChange={(event) => changeLanguage(event.target.value as "English" | "हिन्दी" | "తెలుగు")}
              aria-label="Choose language"
            >
              <option>English</option>
              <option>हिन्दी</option>
              <option>తెలుగు</option>
            </select>
            <button className="theme-toggle-dashboard" type="button" onClick={toggleTheme}>{theme === "black" ? "Black" : "Green"} theme</button>
            <button className="header-action" onClick={() => setView("field")}>New analysis</button>
          </div>
        </header>

        <div className="view-stage" key={view}>
          {view === "overview" && (
            <div className="overview-grid">
              <article className="hero-card">
                <div className="hero-card-overlay">
                  <span>Field decision center</span>
                  <h2>One field. Five coordinated agents.</h2>
                  <p>Scan a crop, reconcile field conditions and receive one governed plan.</p>
                  <button className="primary" onClick={() => setView("disease")}>Scan a crop</button>
                </div>
              </article>
              <article className="metric-card weather-card">
                <span>Rainfall input</span><strong>{form.rain} mm</strong>
                <small>Scenario value · not a live forecast</small>
              </article>
              <article className="metric-card moisture-card">
                <span>Root-zone moisture input</span><strong>{form.moisture}%</strong>
                <div className="moisture-ring"><i>Input</i></div>
                <small>Scenario value · not a live sensor reading</small>
              </article>
              <article className="action-card">
                <div className="action-card-head"><h3>Today’s field workflow</h3><b>4 steps</b></div>
                <div className="workflow-steps">
                  <button onClick={() => setView("disease")}><span>1</span><strong>Crop scan</strong><small>Image and symptoms</small></button>
                  <button onClick={() => setView("field")}><span>2</span><strong>Field context</strong><small>Soil and weather</small></button>
                  <button onClick={() => setView("collaboration")}><span>3</span><strong>Agent review</strong><small>Specialist handoffs</small></button>
                  <button onClick={() => runAgents()}><span>4</span><strong>Run plan</strong><small>Human approval</small></button>
                </div>
              </article>
              <article className="field-map-card">
                <div className="field-map-head"><div><span>Illustrative parcel</span><strong>Anantapur · Sample plot</strong></div><b>Demo only</b></div>
                <div className="field-map" aria-label="Illustrative field map, not connected to live field data">
                  <div className="field-row row-a" /><div className="field-row row-b" /><div className="field-row row-c" />
                  <span className="field-pin pin-a">A1</span><span className="field-pin pin-b">A2</span><span className="field-pin pin-c">A3</span>
                </div>
                <div className="field-map-legend"><span><i className="healthy" />Illustrative zones · no field measurements</span></div>
              </article>
            </div>
          )}

          {view === "disease" && (
            <div className="two-column">
              <article className="panel">
                <div className="panel-title"><span className="eyebrow">Vision agent</span><h2>Crop disease scan</h2></div>
                <label className="image-upload">{imagePreview ? <img src={imagePreview} alt="Crop leaf preview" /> : <><strong>Upload a crop leaf image</strong><small>JPG or PNG · close, clear symptoms preferred</small></>}<input type="file" accept="image/*" capture="environment" onChange={(event) => selectImage(event.target.files?.[0])} /></label>
                <div className="sample-strip">
                  <button type="button" onClick={() => update("issue", "Yellow-brown leaf spots with possible fungal spread")}>Tomato spotting</button>
                  <button type="button" onClick={() => update("issue", "Dark leaf lesions after prolonged humidity")}>Blight pattern</button>
                  <button type="button" onClick={() => update("issue", "No visible disease symptoms")}>Healthy leaf</button>
                </div>
                <label>Observed symptom<textarea value={form.issue} onChange={(event) => update("issue", event.target.value)} /></label>
                <button className="primary full" onClick={() => runAgents()} disabled={loading}>Run disease-to-orchestrator analysis</button>
              </article>
              <article className="panel">
                <div className="panel-title"><span className="eyebrow">Agent response</span><h2>Disease agent</h2></div>
                <div className={`agent-status ${loading ? "working" : ""}`}>{loading ? "Scanning and consulting evidence..." : result.agents[0]?.summary}</div>
                <div className="handoff"><strong>Cross-agent handoff</strong><p>Symptom confidence informs Irrigation risk, Resource checks and the Central Orchestrator.</p></div>
              </article>
            </div>
          )}

          {view === "field" && (
            <article className="panel field-panel">
              <div className="panel-title"><span className="eyebrow">Field inputs</span><h2>Configure the specialist context</h2></div>
              <div className="scenario-row"><button onClick={() => applyScenario("tomato")}>Tomato stress</button><button onClick={() => applyScenario("rice")}>Rice flood risk</button><button onClick={() => applyScenario("maize")}>Maize healthy</button></div>
              <div className="telemetry-grid">
                <div><span>Soil moisture</span><strong>{form.moisture}%</strong><small>Root zone</small></div>
                <div><span>Rain forecast</span><strong>{form.rain} mm</strong><small>Next 24 hours</small></div>
                <div><span>Field crop</span><strong>{form.crop}</strong><small>{form.district}</small></div>
              </div>
              <div className="form-grid">
                <label>Crop<select value={form.crop} onChange={(e) => update("crop", e.target.value)}><option>Tomato</option><option>Rice</option><option>Maize</option><option>Groundnut</option></select></label>
                <label>District<input value={form.district} onChange={(e) => update("district", e.target.value)} /></label>
                <label>Soil<input value={form.soil} onChange={(e) => update("soil", e.target.value)} /></label>
                <label>Moisture %<input type="number" value={form.moisture} onChange={(e) => update("moisture", e.target.value)} /></label>
                <label>Rainfall (mm)<input type="number" value={form.rain} onChange={(e) => update("rain", e.target.value)} /></label>
                <label>Observed issue<input value={form.issue} onChange={(e) => update("issue", e.target.value)} /></label>
              </div>
              <button className="primary full" onClick={() => runAgents()} disabled={loading}>{loading ? "Running all agents..." : "Run agent collaboration"}</button>
            </article>
          )}

          {view === "collaboration" && (
            <div>
              <div className="collaboration-flow">
                {["Disease", "Irrigation", "Resources", "Market", "Orchestrator"].map((name, index) => {
                  const agent = result.agents.find((item) => item.agent === name);
                  const working = loading && activeAgent === name;
                  const connected = name === "Orchestrator"
                    ? result.orchestratorRan === true
                    : agent?.status === "ok";
                  const summary = name === "Orchestrator"
                    ? (result.orchestratorRan ?? null) === null
                      ? "Not run yet."
                      : result.orchestratorRan
                        ? "Coordinated plan ready."
                        : "Skipped for specialist-only analysis."
                    : agent?.summary || "Not run yet.";
                  return (
                    <div className="flow-node" key={name}>
                      <span className={`flow-dot ${working ? "working" : connected ? "connected" : ""}`}>{index + 1}</span>
                      <strong>{name}</strong>
                      <small>{working ? "Analyzing..." : summary}</small>
                    </div>
                  );
                })}
              </div>
              <div className="specialist-grid">
                {[
                  { name: "Disease", icon: "◉", input: "Crop image · symptoms", output: "Likely causes · uncertainty · escalation", handoff: "Irrigation · Resources · Orchestrator" },
                  { name: "Irrigation", icon: "≈", input: "Crop · moisture · rainfall", output: "Water timing · root-zone check", handoff: "Disease · Resources · Orchestrator" },
                  { name: "Resources", icon: "◇", input: "Soil type · district · lab evidence", output: "Nutrient workflow · lab checks", handoff: "Irrigation · Market · Orchestrator" },
                  { name: "Market", icon: "⌁", input: "Crop · district · production index", output: "Mandi evidence · harvest context", handoff: "Resources · Orchestrator" },
                ].map((agent) => {
                  const response = result.agents.find((item) => item.agent === agent.name);
                  const working = loading && activeAgent === agent.name;
                  return (
                    <article className={`specialist-card ${working ? "working" : ""}`} key={agent.name}>
                      <div className="specialist-head"><span>{agent.icon}</span><div><small>Independent specialist</small><h3>{agent.name}</h3></div><b className={response?.status === "ok" ? "connected" : ""}>{working ? "Running" : response?.status === "ok" ? "Responded" : response?.status === "fallback" ? "Fallback" : "Not run"}</b></div>
                      <div className="specialist-input"><strong>Receives</strong><span>{agent.input}</span></div>
                      <div className="specialist-output"><strong>Produces</strong><p>{working ? "Requesting verified evidence and preparing a response..." : response?.summary || "Waiting for analysis."}</p><small>{agent.output}</small></div>
                      <div className="handoff-line"><strong>Handoff</strong><span>{agent.handoff}</span></div>
                      <div className="agent-card-actions">
                        <button type="button" onClick={() => runSpecialist(agent.name as "Disease" | "Irrigation" | "Resources" | "Market")} disabled={loading}>
                          {working ? "Running..." : `Run ${agent.name}`}
                        </button>
                        <button type="button" onClick={() => setView(agent.name === "Disease" ? "disease" : "field")}>Configure input</button>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="orchestrator-card">
                <div><span>◎</span><div><small>{(result.orchestratorRan ?? null) === null ? "Ready when collaboration runs" : result.orchestratorRan ? "Final reconciliation" : "Skipped for specialist-only analysis"}</small><h3>Central Orchestrator</h3></div></div>
                <article><div className="panel-title"><span className="eyebrow">{result.orchestratorRan === true ? "Unified result" : result.orchestratorRan === false ? "Specialist-only result" : "Awaiting analysis"}</span><h2>{result.orchestratorRan === true ? "Coordinated action plan" : result.orchestratorRan === false ? "Not a coordinated plan" : "Run agents to build a plan"}</h2></div><ul className="plan-list">{result.plan.map((item) => <li key={item}>{item}</li>)}</ul>{result.warnings.map((item) => <p className="warning" key={item}>! {item}</p>)}</article>
              </div>
            </div>
          )}

          {view === "evidence" && (
            <article className="panel evidence-panel">
              <div className="panel-title"><span className="eyebrow">Agent knowledge</span><h2>Specialist training profiles</h2></div>
              {[
                ["Disease Agent", "Leaf-symptom triage, crop-specific visual cues, confidence limits and escalation rules."],
                ["Irrigation Agent", "Moisture thresholds, rainfall conflict checks, crop stage and root-zone planning."],
                ["Resources Agent", "Soil-type nutrient workflow, lab-first decisions and fertilizer safety boundaries."],
                ["Market Agent", "District crop context, harvest timing, price evidence and uncertainty disclosure."],
                ["Central Orchestrator", "Cross-agent reconciliation, contradiction detection and human-approval gates."],
              ].map(([name, description]) => (
                <div className="evidence-row" key={name}>
                  <div><strong>{name}</strong><small>{description}</small></div>
                  <b className="training-chip">Local profile</b>
                </div>
              ))}
            </article>
          )}

          {view === "assistant" && (
            <article className="panel chat-view">
              <div className="panel-title"><span className="eyebrow">Field copilot</span><h2>AgroMind AI Assistant</h2></div>
              <div className="chat-log">{chatMessages.map((message, index) => <div className={`chat-message ${message.role}`} key={index}>{message.text}</div>)}</div>
              <form className="chat-form" onSubmit={sendChat}><input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask about the current field..." /><button>Send</button></form>
            </article>
          )}
        </div>
      </section>
      {renderFloatingChat()}
    </main>
  );
}
