export { analyze } from './analyzer.js';
export { parseEnvFile, envMap } from './envfile.js';
export { scanDirectory, scanContent, scanSpringConfig, isSpringConfigFile } from './scanner.js';
export { renderText, renderJson, reportExitCode, setReportRoot } from './report.js';
export { buildPlan, renderPreview, applyPlan, verifyPlanResult, planForFile } from './fixer.js';
export type { FixPlan, FilePlan } from './fixer.js';
export type { DriftReport, AnalyzeOptions, MissingVar, DeadVar, LeakVar } from './analyzer.js';
export type { EnvEntry, ParseResult } from './envfile.js';
export type { EnvRef, ScanResult, SpringScan } from './scanner.js';
