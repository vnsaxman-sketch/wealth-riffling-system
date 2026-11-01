export interface ModelSettings {
  initial_gdp: number;
  initial_debt: number;
  initial_household_wealth: number;
  initial_unemployment: number;
  initial_inflation: number;

  income_tax: number;
  payroll_tax: number;
  corporate_tax: number;
  consumption_tax: number;

  primary_spending_gdp: number;
  baseline_real_growth: number;
  neutral_interest_rate: number;
  inflation_target: number;
  tax_activity_sensitivity: number;
  investment_sensitivity: number;
  fiscal_multiplier: number;
  unemployment_adjustment: number;
  inflation_adjustment: number;
  household_saving_rate: number;
  annual_volatility: number;

  years: number;
  monte_carlo_paths: number;
  random_seed: number;
}

export type SettingKey = keyof ModelSettings;

export const DEFAULT_SETTINGS: ModelSettings = {
  initial_gdp: 29,
  initial_debt: 36,
  initial_household_wealth: 160,
  initial_unemployment: 4.2,
  initial_inflation: 2.5,

  income_tax: 0.135,
  payroll_tax: 0.105,
  corporate_tax: 0.045,
  consumption_tax: 0.015,

  primary_spending_gdp: 0.235,
  baseline_real_growth: 0.02,
  neutral_interest_rate: 0.035,
  inflation_target: 0.02,
  tax_activity_sensitivity: 0.18,
  investment_sensitivity: 0.12,
  fiscal_multiplier: 0.45,
  unemployment_adjustment: 0.3,
  inflation_adjustment: 0.22,
  household_saving_rate: 0.07,
  annual_volatility: 0.018,

  years: 10,
  monte_carlo_paths: 500,
  random_seed: 42,
};

// Initial unemployment and inflation are already percentage-point values.
export const PERCENT_FIELDS = new Set<SettingKey>([
  "income_tax",
  "payroll_tax",
  "corporate_tax",
  "consumption_tax",
  "primary_spending_gdp",
  "baseline_real_growth",
  "neutral_interest_rate",
  "inflation_target",
  "household_saving_rate",
  "annual_volatility",
]);

export const INTEGER_FIELDS = new Set<SettingKey>([
  "years",
  "monte_carlo_paths",
  "random_seed",
]);

export interface QuarterResult {
  quarter: number;
  year: number;
  gdp: number;
  income_tax_revenue: number;
  payroll_revenue: number;
  corporate_revenue: number;
  consumption_revenue: number;
  total_revenue: number;
  primary_spending: number;
  interest_cost: number;
  deficit: number;
  debt: number;
  debt_to_gdp: number;
  unemployment: number;
  inflation: number;
  household_wealth: number;
  effective_revenue_gdp: number;
}

export interface DistributionSummary {
  mean: number;
  median: number;
  p05: number;
  p95: number;
  stdev: number;
}

export interface MonteCarloResult {
  paths: number;
  gdp: DistributionSummary;
  debt_ratio: DistributionSummary;
  wealth: DistributionSummary;
  unemployment: DistributionSummary;
  revenue: DistributionSummary;
  prob_debt_ratio_over_1: number;
  prob_unemployment_over_8: number;
}

export interface OptimizationResult {
  score: number;
  income_tax: number;
  corporate_tax: number;
  spending_gdp: number;
  terminal_gdp: number;
  terminal_debt: number;
  terminal_debt_ratio: number;
  avg_unemployment: number;
  avg_household_wealth: number;
  avg_revenue: number;
}

export type Job = "deterministic" | "monte-carlo" | "optimization";

export interface WorkerRequest {
  job: Job;
  settings: ModelSettings;
}

export type WorkerResponse =
  | { type: "progress"; done: number; total: number }
  | { type: "error"; message: string }
  | { type: "deterministic"; result: QuarterResult[] }
  | { type: "monte-carlo"; result: MonteCarloResult }
  | { type: "optimization"; result: OptimizationResult };

type Progress = (done: number, total: number) => void;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export function validateSettings(s: ModelSettings): void {
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    if (typeof s[key] !== "number" || !Number.isFinite(s[key])) {
      throw new Error(`${key} must be a finite number.`);
    }
  }

  const positive: SettingKey[] = [
    "initial_gdp",
    "initial_debt",
    "initial_household_wealth",
    "years",
    "monte_carlo_paths",
  ];

  for (const key of positive) {
    if (s[key] <= 0) {
      throw new Error(`${key} must be greater than zero.`);
    }
  }

  const rates: SettingKey[] = [
    "income_tax",
    "payroll_tax",
    "corporate_tax",
    "consumption_tax",
    "primary_spending_gdp",
    "household_saving_rate",
  ];

  for (const key of rates) {
    if (s[key] < 0 || s[key] > 1) {
      throw new Error(`${key} must be between 0% and 100%.`);
    }
  }

  for (const key of INTEGER_FIELDS) {
    if (!Number.isSafeInteger(s[key])) {
      throw new Error(`${key} must be a safe integer.`);
    }
  }

  if (s.initial_unemployment < 0 || s.initial_unemployment > 40) {
    throw new Error("Initial unemployment must be between 0% and 40%.");
  }

  if (s.initial_inflation < -5 || s.initial_inflation > 30) {
    throw new Error("Initial inflation must be between -5% and 30%.");
  }

  if (s.years > 50) throw new Error("Years is limited to 50.");
  if (s.monte_carlo_paths > 20_000) {
    throw new Error("Monte Carlo paths is limited to 20,000.");
  }
  if (s.annual_volatility < 0) {
    throw new Error("Annual volatility cannot be negative.");
  }
}

export function parseSettings(data: unknown): ModelSettings {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected a JSON settings object.");
  }

  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      throw new Error(`Unknown setting: ${key}`);
    }
  }

  const candidate = {
    ...DEFAULT_SETTINGS,
    ...data,
  } as ModelSettings;

  validateSettings(candidate);
  return candidate;
}

export function calculateRevenue(
  gdp: number,
  unemployment: number,
  inflation: number,
  s: ModelSettings,
) {
  const employmentFactor = clamp(
    1 - 0.55 * (unemployment - 0.042),
    0.65,
    1.12,
  );

  const cycleFactor = clamp(
    1 + 2 * (0.02 - unemployment + 0.042),
    0.65,
    1.25,
  );

  const inflationFactor = clamp(
    1 + 0.2 * (inflation - 0.02),
    0.85,
    1.2,
  );

  const income = gdp * 0.55 * employmentFactor * s.income_tax;
  const payroll = gdp * 0.48 * employmentFactor * s.payroll_tax;
  const corporate = gdp * 0.09 * cycleFactor * s.corporate_tax;
  const consumption =
    gdp *
    0.65 *
    employmentFactor *
    inflationFactor *
    s.consumption_tax;

  return {
    income,
    payroll,
    corporate,
    consumption,
    total: income + payroll + corporate + consumption,
  };
}

export function runDeterministic(
  s: ModelSettings,
  shocks: readonly number[] = [],
): QuarterResult[] {
  validateSettings(s);

  let gdp = s.initial_gdp;
  let debt = s.initial_debt;
  let wealth = s.initial_household_wealth;
  let unemployment = s.initial_unemployment / 100;
  let inflation = s.initial_inflation / 100;
  let previousSpendingRatio = s.primary_spending_gdp;

  const output: QuarterResult[] = [];
  const dt = 0.25;

  for (let q = 1; q <= s.years * 4; q++) {
    const combinedRate =
      0.55 * s.income_tax +
      0.48 * s.payroll_tax +
      0.09 * s.corporate_tax +
      0.65 * s.consumption_tax;

    const taxDrag =
      s.tax_activity_sensitivity * (combinedRate - 0.16);

    const investmentContribution =
      s.investment_sensitivity * (s.household_saving_rate - 0.07);

    const spendingImpulse =
      s.fiscal_multiplier *
      (s.primary_spending_gdp - previousSpendingRatio);

    const annualGrowth = clamp(
      s.baseline_real_growth -
        taxDrag +
        investmentContribution +
        spendingImpulse +
        (shocks[q - 1] ?? 0),
      -0.2,
      0.15,
    );

    gdp *= Math.max(0.5, 1 + annualGrowth * dt);

    const outputGap = annualGrowth - s.baseline_real_growth;

    unemployment = clamp(
      unemployment - s.unemployment_adjustment * outputGap * dt,
      0.025,
      0.25,
    );

    inflation = clamp(
      inflation +
        s.inflation_adjustment *
          (s.inflation_target - inflation) *
          dt +
        0.08 * outputGap * dt,
      -0.02,
      0.2,
    );

    const revenue = calculateRevenue(
      gdp,
      unemployment,
      inflation,
      s,
    );

    const primarySpending = gdp * s.primary_spending_gdp;

    const effectiveRate = clamp(
      s.neutral_interest_rate +
        0.012 * (debt / Math.max(gdp, 0.01) - 1),
      0,
      0.15,
    );

    const interestCost = debt * effectiveRate * dt;
    const deficit =
      primarySpending * dt + interestCost - revenue.total * dt;

    debt = Math.max(0, debt + deficit);

    const householdIncome = gdp * 0.62;
    const householdTax =
      revenue.income + revenue.payroll + 0.45 * revenue.consumption;

    const disposable = Math.max(0, householdIncome - householdTax);
    const consumption = disposable * (1 - s.household_saving_rate);
    const savingFlow = Math.max(-0.02 * wealth, disposable - consumption);

    wealth = Math.max(
      0,
      wealth + savingFlow * dt + wealth * 0.02 * dt,
    );

    const row: QuarterResult = {
      quarter: q,
      year: q / 4,
      gdp,
      income_tax_revenue: revenue.income,
      payroll_revenue: revenue.payroll,
      corporate_revenue: revenue.corporate,
      consumption_revenue: revenue.consumption,
      total_revenue: revenue.total,
      primary_spending: primarySpending,
      interest_cost: interestCost / dt,
      deficit: deficit / dt,
      debt,
      debt_to_gdp: debt / Math.max(gdp, 0.001),
      unemployment: unemployment * 100,
      inflation: inflation * 100,
      household_wealth: wealth,
      effective_revenue_gdp: revenue.total / Math.max(gdp, 0.001),
    };

    if (Object.values(row).some((v) => !Number.isFinite(v))) {
      throw new Error(
        "Model overflow. Reduce the magnitude of your assumptions.",
      );
    }

    output.push(row);
    previousSpendingRatio = s.primary_spending_gdp;
  }

  return output;
}

// Mulberry32 uniforms with Box–Muller normal draws.
// Reproducible here, but not identical to Python random.Random.
function normalGenerator(seed: number) {
  let state = seed >>> 0;
  let spare: number | undefined;

  const uniform = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return () => {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }

    const radius = Math.sqrt(-2 * Math.log(1 - uniform()));
    const angle = 2 * Math.PI * uniform();

    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

export function summarize(values: number[]): DistributionSummary {
  if (!values.length) throw new Error("Cannot summarize an empty sample.");

  const ordered = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;

  const percentile = (p: number) => {
    const index = (ordered.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);

    return (
      ordered[low] +
      (ordered[high] - ordered[low]) * (index - low)
    );
  };

  return {
    mean,
    median: percentile(0.5),
    p05: percentile(0.05),
    p95: percentile(0.95),
    stdev: Math.sqrt(
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
        Math.max(1, values.length - 1),
    ),
  };
}

export function runMonteCarlo(
  s: ModelSettings,
  progress: Progress = () => {},
): MonteCarloResult {
  validateSettings(s);

  const normal = normalGenerator(s.random_seed);
  const n = s.monte_carlo_paths;

  const gdp: number[] = [];
  const debt: number[] = [];
  const wealth: number[] = [];
  const unemployment: number[] = [];
  const revenue: number[] = [];

  for (let i = 0; i < n; i++) {
    const shocks = Array.from(
      { length: s.years * 4 },
      () => normal() * s.annual_volatility,
    );

    const rows = runDeterministic(s, shocks);
    const last = rows[rows.length - 1];

    gdp.push(last.gdp);
    debt.push(last.debt_to_gdp);
    wealth.push(last.household_wealth);
    unemployment.push(last.unemployment);
    revenue.push(last.total_revenue);

    if (
      (i + 1) % Math.max(1, Math.floor(n / 100)) === 0 ||
      i === n - 1
    ) {
      progress(i + 1, n);
    }
  }

  return {
    paths: n,
    gdp: summarize(gdp),
    debt_ratio: summarize(debt),
    wealth: summarize(wealth),
    unemployment: summarize(unemployment),
    revenue: summarize(revenue),
    prob_debt_ratio_over_1: debt.filter((x) => x > 1).length / n,
    prob_unemployment_over_8:
      unemployment.filter((x) => x > 8).length / n,
  };
}

export function optimizePolicy(
  base: ModelSettings,
  progress: Progress = () => {},
): OptimizationResult {
  validateSettings(base);

  let best: OptimizationResult | undefined;
  let count = 0;

  for (const income of [0.105, 0.12, 0.135, 0.15, 0.165]) {
    for (const corporate of [0.025, 0.035, 0.045, 0.055, 0.065]) {
      for (const spending of [0.21, 0.225, 0.235, 0.245, 0.26]) {
        const rows = runDeterministic({
          ...base,
          income_tax: income,
          corporate_tax: corporate,
          primary_spending_gdp: spending,
        });

        const final = rows[rows.length - 1];
        const tail = rows.slice(-8);

        const average = (key: keyof QuarterResult) =>
          tail.reduce((sum, row) => sum + row[key], 0) / tail.length;

        const avgRevenue = average("total_revenue");
        const avgUnemployment = average("unemployment");
        const avgWealth = average("household_wealth");

        const debtPenalty =
          Math.max(0, final.debt_to_gdp - 1.2) * 12;

        const unemploymentPenalty =
          Math.max(0, avgUnemployment - 7) * 3;

        const wealthPenalty =
          Math.max(
            0,
            (base.initial_household_wealth * 1.05 - avgWealth) /
              Math.max(base.initial_household_wealth, 1),
          ) * 8;

        const score =
          2 * (avgRevenue / Math.max(final.gdp, 0.01)) +
          0.35 *
            (avgWealth / Math.max(base.initial_household_wealth, 1)) -
          debtPenalty -
          unemploymentPenalty -
          wealthPenalty;

        const candidate: OptimizationResult = {
          score,
          income_tax: income,
          corporate_tax: corporate,
          spending_gdp: spending,
          terminal_gdp: final.gdp,
          terminal_debt: final.debt,
          terminal_debt_ratio: final.debt_to_gdp,
          avg_unemployment: avgUnemployment,
          avg_household_wealth: avgWealth,
          avg_revenue: avgRevenue,
        };

        if (!best || candidate.score > best.score) {
          best = candidate;
        }

        count++;
        if (count % 5 === 0) progress(count, 125);
      }
    }
  }

  return best!;
}

