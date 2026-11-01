import { useEffect, useRef, useState } from "react";

import {
  DEFAULT_SETTINGS,
  INTEGER_FIELDS,
  PERCENT_FIELDS,
  parseSettings,
  validateSettings,
} from "./model";

import type {
  Job,
  ModelSettings,
  MonteCarloResult,
  OptimizationResult,
  QuarterResult,
  SettingKey,
  WorkerResponse,
} from "./model";

type Draft = Record<SettingKey, string>;

interface Snapshot<T> {
  settings: ModelSettings;
  result: T;
}

const TABS = [
  "Dashboard",
  "Assumptions",
  "Simulation",
  "Optimization",
  "Data & Methods",
] as const;

type Tab = (typeof TABS)[number];

const GROUPS: {
  title: string;
  fields: [SettingKey, string][];
}[] = [
  {
    title: "Initial conditions",
    fields: [
      ["initial_gdp", "Initial GDP ($T)"],
      ["initial_debt", "Initial federal debt proxy ($T)"],
      ["initial_household_wealth", "Initial household wealth ($T)"],
      ["initial_unemployment", "Initial unemployment (%)"],
      ["initial_inflation", "Initial inflation (%)"],
    ],
  },
  {
    title: "Effective tax-rate assumptions",
    fields: [
      ["income_tax", "Individual income tax (%)"],
      ["payroll_tax", "Payroll tax (%)"],
      ["corporate_tax", "Corporate tax (%)"],
      ["consumption_tax", "Consumption / excise tax (%)"],
    ],
  },
  {
    title: "Fiscal and macro assumptions",
    fields: [
      ["primary_spending_gdp", "Primary spending / GDP (%)"],
      ["baseline_real_growth", "Baseline annual real growth (%)"],
      ["neutral_interest_rate", "Neutral annual interest rate (%)"],
      ["inflation_target", "Inflation target (%)"],
      ["tax_activity_sensitivity", "Tax activity sensitivity"],
      ["investment_sensitivity", "Investment sensitivity"],
      ["fiscal_multiplier", "Fiscal multiplier"],
      ["unemployment_adjustment", "Unemployment adjustment"],
      ["inflation_adjustment", "Inflation adjustment"],
      ["household_saving_rate", "Household saving rate (%)"],
      ["annual_volatility", "Annualized growth shock volatility (%)"],
    ],
  },
  {
    title: "Simulation controls",
    fields: [
      ["years", "Projection horizon (years)"],
      ["monte_carlo_paths", "Monte Carlo paths"],
      ["random_seed", "Random seed"],
    ],
  },
];

const COLUMNS: [keyof QuarterResult, string, boolean?][] = [
  ["year", "Year"],
  ["gdp", "GDP"],
  ["total_revenue", "Revenue"],
  ["primary_spending", "Primary spend"],
  ["interest_cost", "Interest"],
  ["deficit", "Deficit"],
  ["debt", "Debt"],
  ["debt_to_gdp", "Debt / GDP", true],
  ["unemployment", "Unemployment %"],
  ["inflation", "Inflation %"],
  ["household_wealth", "Household wealth"],
];

const format = (n: number, digits = 2) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

const percent = (n: number) => `${format(n * 100, 1)}%`;
const labelize = (key: string) => key.replaceAll("_", " ");

function toDraft(settings: ModelSettings): Draft {
  return Object.fromEntries(
    (Object.keys(settings) as SettingKey[]).map((key) => [
      key,
      String(
        Number(
          (
            settings[key] * (PERCENT_FIELDS.has(key) ? 100 : 1)
          ).toPrecision(12),
        ),
      ),
    ]),
  ) as Draft;
}

function download(
  filename: string,
  content: string,
  mime = "application/json",
) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJSON(filename: string, data: unknown) {
  download(filename, JSON.stringify(data, null, 2));
}

export default function App() {
  const [tab, setTab] = useState<Tab>("Dashboard");
  const [draft, setDraft] = useState<Draft>(() =>
    toDraft(DEFAULT_SETTINGS),
  );

  const [baseline, setBaseline] =
    useState<Snapshot<QuarterResult[]> | null>(null);

  const [monteCarlo, setMonteCarlo] =
    useState<Snapshot<MonteCarloResult> | null>(null);

  const [optimization, setOptimization] =
    useState<Snapshot<OptimizationResult> | null>(null);

  const [busy, setBusy] = useState<Job | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(
    "Ready · Demonstration model · No live data connected",
  );

  const workerRef = useRef<Worker | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => workerRef.current?.terminate();
  }, []);

  const rows = baseline?.result ?? [];
  const last = rows[rows.length - 1];

  function readSettings(): ModelSettings {
    const candidate = { ...DEFAULT_SETTINGS };

    for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
      const raw = draft[key].trim().replaceAll(",", "");

      if (!raw) throw new Error(`${key} is required.`);

      const value = Number(raw);

      if (!Number.isFinite(value)) {
        throw new Error(`${key} must be numeric.`);
      }

      if (INTEGER_FIELDS.has(key) && !Number.isSafeInteger(value)) {
        throw new Error(`${key} must be a safe integer.`);
      }

      candidate[key] =
        value / (PERCENT_FIELDS.has(key) ? 100 : 1);
    }

    validateSettings(candidate);
    return candidate;
  }

  function applySettings(): ModelSettings | null {
    try {
      const settings = readSettings();
      setError("");
      setStatus(
        "Assumptions applied. Existing results retain their run-time settings.",
      );
      return settings;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  function stopWorker() {
    workerRef.current?.terminate();
    workerRef.current = null;
    setBusy(null);
  }

  function start(job: Job) {
    if (workerRef.current) return;

    const settings = applySettings();
    if (!settings) return;

    setBusy(job);
    setProgress(0);
    setStatus(`Running ${job}…`);

    try {
      const worker = new Worker(
        new URL("./engine.worker.ts", import.meta.url),
        { type: "module" },
      );

      workerRef.current = worker;

      worker.onmessage = (
        event: MessageEvent<WorkerResponse>,
      ) => {
        const message = event.data;

        if (message.type === "progress") {
          setProgress((message.done / message.total) * 100);
          return;
        }

        if (message.type === "error") {
          setError(message.message);
          setStatus("Run failed.");
          stopWorker();
          return;
        }

        if (message.type === "deterministic") {
          setBaseline({ settings, result: message.result });
          setTab("Dashboard");
        }

        if (message.type === "monte-carlo") {
          setMonteCarlo({ settings, result: message.result });
          setTab("Simulation");
        }

        if (message.type === "optimization") {
          setOptimization({ settings, result: message.result });
          setTab("Optimization");
        }

        setProgress(100);
        setStatus(
          `${job} complete · Results use settings captured at run time`,
        );
        stopWorker();
      };

      worker.onerror = (event) => {
        setError(event.message || "Worker failed.");
        setStatus("Run failed.");
        stopWorker();
      };

      worker.onmessageerror = () => {
        setError("Unable to read the worker response.");
        setStatus("Run failed.");
        stopWorker();
      };

      worker.postMessage({ job, settings });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("Unable to start worker.");
      stopWorker();
    }
  }

  function exportCSV() {
    if (!rows.length) return;

    const keys = Object.keys(rows[0]) as (keyof QuarterResult)[];
    const csv = [
      keys.join(","),
      ...rows.map((row) => keys.map((key) => row[key]).join(",")),
    ].join("\r\n");

    download(
      "riffle_quarterly_results.csv",
      csv,
      "text/csv;charset=utf-8",
    );
  }

  const metrics = [
    ["GDP", last ? `$${format(last.gdp)}` : "—", "USD trillions"],
    [
      "Federal-style revenue",
      last ? `$${format(last.total_revenue)}` : "—",
      "Annualized proxy · USD trillions",
    ],
    [
      "Debt / GDP",
      last ? percent(last.debt_to_gdp) : "—",
      "Terminal ratio",
    ],
    [
      "Unemployment",
      last ? `${format(last.unemployment, 1)}%` : "—",
      "Terminal rate",
    ],
    [
      "Household wealth",
      last ? `$${format(last.household_wealth, 1)}` : "—",
      "Modeled stock · USD trillions",
    ],
  ];

  return (
    <div className="app">
      <header>
        <div className="logo">R</div>
        <div>
          <div className="eyebrow">RIFFLE SYSTEM / v1.0.0</div>
          <h1>Wealth Riffling System</h1>
          <p>U.S. Wealth Flow & Economic Resilience Lab</p>
          <small>Developed by: Long Nguyen</small>
        </div>
        <span className="badge">EDUCATIONAL SANDBOX</span>
      </header>

      <div className="warning">
        <strong>Illustrative model, not a forecast.</strong> No live
        government data. Not a tax calculator, investment tool or
        policy recommendation.
      </div>

      <nav aria-label="Main sections">
        {TABS.map((name) => (
          <button
            key={name}
            className={tab === name ? "active" : ""}
            aria-current={tab === name ? "page" : undefined}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>

      {error && (
        <div className="error" role="alert">
          {error}
          <button
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      )}

      <main>
        {tab === "Dashboard" && (
          <>
            <div className="section-heading">
              <div>
                <h2>Economic overview</h2>
                <p>
                  {baseline
                    ? `Terminal state · ${baseline.settings.years}-year baseline`
                    : "Configure assumptions and run a quarterly projection."}
                </p>
              </div>
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => start("deterministic")}
              >
                Run simulation
              </button>
            </div>

            <div className="metrics">
              {metrics.map(([title, value, note]) => (
                <section className="card metric" key={title}>
                  <span>{title}</span>
                  <strong>{value}</strong>
                  <small>{note}</small>
                </section>
              ))}
            </div>

            <section className="card">
              <h3>Economic trajectory</h3>
              <TrendChart rows={rows} />
            </section>

            <section className="card">
              <h3>Revenue composition</h3>
              {last ? (
                <>
                  <div className="revenue">
                    {(
                      [
                        ["Individual income", last.income_tax_revenue],
                        ["Payroll", last.payroll_revenue],
                        ["Corporate", last.corporate_revenue],
                        ["Consumption / excise", last.consumption_revenue],
                      ] as [string, number][]
                    ).map(([name, value]) => (
                      <div key={name}>
                        <span>{name}</span>
                        <strong>${format(value)}T</strong>
                        <small>
                          {percent(
                            last.total_revenue
                              ? value / last.total_revenue
                              : 0,
                          )}{" "}
                          of revenue
                        </small>
                      </div>
                    ))}
                  </div>
                  <p>
                    Annualized deficit: ${format(last.deficit)}T ·
                    Inflation: {format(last.inflation, 1)}% · Effective
                    revenue / GDP:{" "}
                    {percent(last.effective_revenue_gdp)}
                  </p>
                </>
              ) : (
                <p>Run a baseline simulation to display results.</p>
              )}
            </section>
          </>
        )}

        {tab === "Assumptions" && (
          <>
            <h2>Model assumptions</h2>
            <p>
              Enter percentages as displayed. JSON stores fractional
              rates except initial unemployment and inflation.
            </p>

            <fieldset disabled={!!busy} className="form-fieldset">
              <div className="assumptions-grid">
                {GROUPS.map((group) => (
                  <section className="card" key={group.title}>
                    <h3>{group.title}</h3>
                    {group.fields.map(([key, label]) => (
                      <div className="field" key={key}>
                        <label htmlFor={key}>{label}</label>
                        <input
                          id={key}
                          type="text"
                          inputMode={
                            INTEGER_FIELDS.has(key)
                              ? "numeric"
                              : "decimal"
                          }
                          value={draft[key]}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [key]: event.target.value,
                            })
                          }
                        />
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </fieldset>

            <div className="actions">
              <button
                className="primary"
                disabled={!!busy}
                onClick={applySettings}
              >
                Apply assumptions
              </button>

              <button
                disabled={!!busy}
                onClick={() => {
                  setDraft(toDraft(DEFAULT_SETTINGS));
                  setError("");
                  setStatus("Default assumptions restored.");
                }}
              >
                Restore defaults
              </button>

              <button
                disabled={!!busy}
                onClick={() => {
                  const settings = applySettings();
                  if (settings) {
                    downloadJSON("riffle_assumptions.json", settings);
                  }
                }}
              >
                Save assumptions JSON
              </button>

              <button
                disabled={!!busy}
                onClick={() => fileRef.current?.click()}
              >
                Load assumptions JSON
              </button>

              <input
                ref={fileRef}
                hidden
                type="file"
                accept=".json,application/json"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;

                  try {
                    const settings = parseSettings(
                      JSON.parse(await file.text()),
                    );
                    setDraft(toDraft(settings));
                    setError("");
                    setStatus(`Loaded ${file.name}`);
                  } catch (e) {
                    setError(
                      e instanceof Error ? e.message : String(e),
                    );
                  }
                }}
              />
            </div>
          </>
        )}

        {tab === "Simulation" && (
          <>
            <div className="section-heading">
              <div>
                <h2>Simulation workspace</h2>
                <p>Quarterly baseline and terminal distributions</p>
              </div>
              <div className="actions">
                <button
                  className="primary"
                  disabled={!!busy}
                  onClick={() => start("deterministic")}
                >
                  Run simulation
                </button>
                <button
                  disabled={!!busy}
                  onClick={() => start("monte-carlo")}
                >
                  Run Monte Carlo
                </button>
              </div>
            </div>

            <section className="card">
              <h3>Baseline results</h3>
              {last ? (
                <p>
                  {rows.length} quarters · Terminal GDP $
                  {format(last.gdp)}T · Debt ${format(last.debt)}T ·
                  Debt / GDP {percent(last.debt_to_gdp)} · Household
                  wealth ${format(last.household_wealth)}T
                </p>
              ) : (
                <p>No baseline simulation has been run yet.</p>
              )}
            </section>

            <section className="card">
              <div className="section-heading">
                <h3>Monte Carlo terminal distributions</h3>
                <button
                  disabled={!monteCarlo}
                  onClick={() =>
                    monteCarlo &&
                    downloadJSON(
                      "riffle_monte_carlo.json",
                      monteCarlo,
                    )
                  }
                >
                  Export JSON
                </button>
              </div>

              {monteCarlo ? (
                <>
                  <p>
                    {monteCarlo.result.paths.toLocaleString()} paths ·{" "}
                    {monteCarlo.settings.years} years · Seed{" "}
                    {monteCarlo.settings.random_seed}
                  </p>
                  <MonteCarloTable result={monteCarlo.result} />
                  <p>
                    Probability debt / GDP exceeds 100%:{" "}
                    <strong>
                      {percent(
                        monteCarlo.result.prob_debt_ratio_over_1,
                      )}
                    </strong>
                    {" · "}
                    Probability unemployment exceeds 8%:{" "}
                    <strong>
                      {percent(
                        monteCarlo.result.prob_unemployment_over_8,
                      )}
                    </strong>
                  </p>
                </>
              ) : (
                <p>
                  No Monte Carlo run yet. Monte Carlo does not replace
                  your baseline trajectory.
                </p>
              )}
            </section>

            <section className="card">
              <div className="section-heading">
                <div>
                  <h3>Quarterly output</h3>
                  <p>
                    USD trillions unless indicated. Flow columns are
                    annualized; debt and wealth are stocks.
                  </p>
                </div>
                <button
                  disabled={!rows.length}
                  onClick={exportCSV}
                >
                  Export CSV
                </button>
              </div>

              <div className="table-wrap quarterly">
                <table>
                  <thead>
                    <tr>
                      {COLUMNS.map(([key, label]) => (
                        <th key={key}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.quarter}>
                        {COLUMNS.map(([key, , ratio]) => (
                          <td key={key}>
                            {ratio
                              ? percent(row[key])
                              : format(
                                  row[key],
                                  key === "year" ? 2 : 3,
                                )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {!rows.length && (
                  <div className="empty">No quarterly results yet.</div>
                )}
              </div>
            </section>
          </>
        )}

        {tab === "Optimization" && (
          <>
            <h2>Constrained policy exploration</h2>
            <p>
              A transparent search compares 125 combinations of
              effective income-tax, corporate-tax and spending
              assumptions. Its illustrative score balances revenue
              capacity with debt, unemployment and household-wealth
              penalties. This is not a recommended tax policy.
            </p>

            <div className="actions">
              <button
                className="primary"
                disabled={!!busy}
                onClick={() => start("optimization")}
              >
                Run policy grid search
              </button>
              <button
                disabled={!optimization}
                onClick={() =>
                  optimization &&
                  downloadJSON(
                    "riffle_best_candidate.json",
                    optimization.result,
                  )
                }
              >
                Export best candidate JSON
              </button>
            </div>

            <section className="card">
              <h3>
                {optimization
                  ? "Best candidate in this grid"
                  : "No optimization run yet"}
              </h3>

              {optimization ? (
                <>
                  <div className="candidate">
                    {Object.entries(optimization.result).map(
                      ([key, value]) => (
                        <div key={key}>
                          <span>{labelize(key)}</span>
                          <strong>
                            {[
                              "income_tax",
                              "corporate_tax",
                              "spending_gdp",
                              "terminal_debt_ratio",
                            ].includes(key)
                              ? percent(value)
                              : format(value, 4)}
                          </strong>
                        </div>
                      ),
                    )}
                  </div>

                  <p>
                    Horizon: {optimization.settings.years} years.
                    GDP, debt, wealth and revenue use USD trillions.
                    Unemployment uses percentage points. Averages
                    cover the final eight quarters, or all quarters
                    if fewer.
                  </p>

                  <button
                    disabled={!!busy}
                    onClick={() => {
                      setDraft(
                        toDraft({
                          ...optimization.settings,
                          income_tax:
                            optimization.result.income_tax,
                          corporate_tax:
                            optimization.result.corporate_tax,
                          primary_spending_gdp:
                            optimization.result.spending_gdp,
                        }),
                      );
                      setTab("Assumptions");
                      setStatus(
                        "Candidate copied to assumptions. Run a new simulation to evaluate it.",
                      );
                    }}
                  >
                    Copy candidate to assumptions
                  </button>
                </>
              ) : (
                <p>
                  Search ranges: income tax 10.5–16.5%, corporate tax
                  2.5–6.5%, primary spending / GDP 21–26%.
                </p>
              )}
            </section>
          </>
        )}

        {tab === "Data & Methods" && <Methods />}
      </main>

      <footer>
        <span role="status">{status}</span>
        <div className="actions">
          {busy && (
            <button
              onClick={() => {
                stopWorker();
                setProgress(0);
                setStatus(
                  "Run cancelled. Previous results retained.",
                );
              }}
            >
              Cancel run
            </button>
          )}
          <progress
            aria-label="Simulation progress"
            value={progress}
            max={100}
          />
        </div>
      </footer>
    </div>
  );
}

function TrendChart({ rows }: { rows: QuarterResult[] }) {
  if (!rows.length) {
    return (
      <div className="empty">
        Run a simulation to display the economic trajectory.
      </div>
    );
  }

  const series = [
    ["gdp", "GDP", "#2563eb"],
    ["total_revenue", "Revenue", "#119b7b"],
    ["debt", "Debt", "#dc9827"],
  ] as const;

  const values = rows.flatMap((row) =>
    series.map(([key]) => row[key]),
  );

  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.12, 0.1);
  const low = min - padding;
  const high = max + padding;

  const x = (index: number) =>
    70 + (index * 890) / Math.max(1, rows.length - 1);

  const y = (value: number) =>
    275 - ((value - low) / (high - low)) * 245;

  return (
    <>
      <svg
        viewBox="0 0 1000 325"
        role="img"
        aria-label="GDP, annualized revenue and debt over the simulation, in USD trillions"
      >
        {Array.from({ length: 5 }, (_, index) => {
          const value = high - (index * (high - low)) / 4;
          return (
            <g key={index}>
              <line
                x1={70}
                x2={960}
                y1={y(value)}
                y2={y(value)}
                stroke="#e6edf5"
              />
              <text
                x={58}
                y={y(value) + 4}
                textAnchor="end"
              >
                {value.toFixed(1)}
              </text>
            </g>
          );
        })}

        {series.map(([key, label, color]) => (
          <polyline
            key={key}
            fill="none"
            stroke={color}
            strokeWidth={3}
            points={rows
              .map((row, index) => `${x(index)},${y(row[key])}`)
              .join(" ")}
          >
            <title>{label}</title>
          </polyline>
        ))}

        <text x={70} y={305}>
          Year {rows[0].year}
        </text>
        <text x={960} y={305} textAnchor="end">
          Year {rows[rows.length - 1].year}
        </text>
      </svg>

      <div className="legend">
        {series.map(([, label, color]) => (
          <span key={label}>
            <i style={{ background: color }} />
            {label}
          </span>
        ))}
        <span>USD trillions</span>
      </div>
    </>
  );
}

function MonteCarloTable({
  result,
}: {
  result: MonteCarloResult;
}) {
  const metrics = [
    ["gdp", "GDP ($T)"],
    ["debt_ratio", "Debt / GDP"],
    ["wealth", "Household wealth ($T)"],
    ["unemployment", "Unemployment (%)"],
    ["revenue", "Annualized revenue ($T)"],
  ] as const;

  const statistics = [
    ["mean", "Mean"],
    ["median", "Median"],
    ["p05", "5th percentile"],
    ["p95", "95th percentile"],
    ["stdev", "Std. deviation"],
  ] as const;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            {statistics.map(([key, label]) => (
              <th key={key}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metrics.map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              {statistics.map(([stat]) => (
                <td key={stat}>
                  {key === "debt_ratio"
                    ? percent(result[key][stat])
                    : format(result[key][stat])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Methods() {
  const sources = [
    ["Congressional Budget Office", "https://www.cbo.gov/"],
    ["Treasury Fiscal Data", "https://fiscaldata.treasury.gov/"],
    ["Bureau of Economic Analysis", "https://www.bea.gov/data"],
    ["Bureau of Labor Statistics", "https://www.bls.gov/data/"],
    ["Internal Revenue Service", "https://www.irs.gov/statistics"],
    ["Federal Reserve", "https://www.federalreserve.gov/data.htm"],
  ];

  return (
    <article className="card methods">
      <h2>Data, equations & limitations</h2>

      <h3>Purpose</h3>
      <p>
        RIFFLE is a local educational sandbox, not an official
        government model, forecast, tax filing tool, investment tool
        or policy recommendation system. It does not estimate causal
        effects or reconstruct the U.S. tax code.
      </p>

      <h3>Revenue proxies</h3>
      <pre>{`Income tax = GDP × 0.55 × employment factor × income rate
Payroll tax = GDP × 0.48 × employment factor × payroll rate
Corporate tax = GDP × 0.09 × cycle factor × corporate rate
Consumption tax = GDP × 0.65 × employment factor × inflation factor × rate

Employment factor = clamp(1 − 0.55 × (u − 0.042), 0.65, 1.12)
Cycle factor = clamp(1 + 2 × (0.02 − u + 0.042), 0.65, 1.25)
Inflation factor = clamp(1 + 0.20 × (inflation − 0.02), 0.85, 1.20)`}</pre>
      <p>
        Here unemployment and inflation are fractions. Tax-base shares
        are fixed assumptions in model.ts; effective rates are
        editable. Federal, state and local revenues are not fully
        separated. Do not add these proxies to official totals.
      </p>

      <h3>Debt accumulation</h3>
      <pre>{`Quarterly interest = debt × effective annual interest rate × 0.25
Quarterly deficit = primary spending × 0.25
                  + quarterly interest − annualized revenue × 0.25
New debt = max(0, previous debt + quarterly deficit)`}</pre>
      <p>
        Flow columns are annualized; debt and household wealth are
        stocks. The model omits Treasury maturity structure, sectoral
        accounting, trade, demographics and a monetary-policy rule.
        GDP follows the source real-growth proxy without separate
        inflation adjustment, so its dollar-level interpretation is
        stylized.
      </p>

      <h3>Dynamic system</h3>
      <p>
        GDP, unemployment, inflation, debt and household wealth advance
        using quarterly Euler-style updates. Full equations and clamps
        are implemented transparently in model.ts. The spending ratio
        is fixed within a run and initializes its own previous value,
        so the fiscal-impulse term is always zero. Consequently, the
        fiscal multiplier has no effect in this fixed-policy version,
        preserving the supplied model.
      </p>

      <h3>Monte Carlo</h3>
      <p>
        Each quarter receives an independent normal draw with the
        specified annualized growth-shock standard deviation. Draws
        are not rescaled by the square root of time, preserving the
        original algorithm. Mulberry32 and Box–Muller provide seeded
        randomness; sequences differ from Python random.Random.
        Percentiles use linear interpolation and standard deviation
        uses the sample denominator. These scenario percentiles are
        not empirically validated confidence intervals.
      </p>

      <h3>Grid-search objective</h3>
      <pre>{`Score = 2 × (average revenue / final GDP)
      + 0.35 × (average wealth / max(initial wealth, 1))
      − 12 × max(0, final debt/GDP − 1.20)
      − 3 × max(0, average unemployment − 7)
      − 8 × max(0,
          (initial wealth × 1.05 − average wealth)
          / max(initial wealth, 1))`}</pre>
      <p>
        Averages cover the final eight quarters, or all quarters if
        fewer. These are soft penalties, not hard feasibility
        constraints or a validated social-welfare function.
        Optimization can exploit model weaknesses.
      </p>

      <h3>Research extensions</h3>
      <p>
        Estimate elasticities from credible data, calibrate
        stock-flow-consistent accounts, model correlated shocks and
        recession regimes, add distributional results, and evaluate
        out-of-sample forecast errors.
      </p>

      <h3>Potential official data sources</h3>
      <div className="source-links">
        {sources.map(([label, url]) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {label} ↗
          </a>
        ))}
      </div>
      <p>
        No external data APIs, remote fonts or analytics are connected.
        Links open only when selected. Imports and exports stay in
        your browser; settings are not automatically persisted.
      </p>
    </article>
  );
}

