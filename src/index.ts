export { analyze } from './analyzer.js';
export { parseEnvFile, envMap } from './envfile.js';
export { scanDirectory, scanContent } from './scanner.js';
export { renderText, renderJson, reportExitCode } from './report.js';
export type { DriftReport, AnalyzeOptions, MissingVar, DeadVar, LeakVar } from './analyzer.js';
export type { EnvEntry, ParseResult } from './envfile.js';
export type { EnvRef, ScanResult } from './scanner.js';
