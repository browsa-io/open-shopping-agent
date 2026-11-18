// Price-drop and back-in-stock watches. Entry points:
//   new WatchStore(dir).add({ query, stores, targetPrice, notify })  save a watch
//   checkWatch(watch, { check })                                       run one now
//   runDueWatches({ check })                                           one pass, for cron
//   startWatching({ check })                                           a loop until stop()
//   runWatchCli(args, { check })                                       the `osa watch` commands
// `check(watch) => Offer[]` comes from the engine; see CheckFn in ./types.ts.

export * from "./types.js";
export { WatchStore, normalizeWatch, storeFromUrl, defaultDir, MIN_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES } from "./store.js";
export { evaluate, evaluateFailure, eligible, snapshot, FAILING_AFTER } from "./evaluate.js";
export {
  createNotifiers, configFromEnv, deliver, signPayload, verifySignature, alertText, alertSubject,
  slackNotifier, webhookNotifier, emailNotifier, desktopNotifier, SIGNATURE_HEADER, TIMESTAMP_HEADER,
} from "./notify.js";
export { sendMail, buildMessage } from "./smtp.js";
export { checkWatch, runDueWatches, startWatching, nextDue } from "./checker.js";
export type { CheckDeps, CheckResult, Watcher } from "./checker.js";
export { runWatchCli, parseEvery, WATCH_HELP } from "./cli.js";
