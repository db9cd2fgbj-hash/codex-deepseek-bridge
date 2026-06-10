import { runDeepSeekLogin } from "./deepseek-auth.mjs";

function parseArgs(argv) {
  const args = {
    attachOnly: false,
    port: undefined,
    timeoutMs: undefined,
    browser: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--attach-only") {
      args.attachOnly = true;
    } else if (arg === "--port") {
      args.port = Number(argv[++i]);
    } else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(argv[++i]);
    } else if (arg === "--browser") {
      args.browser = argv[++i] || "";
    }
  }
  return args;
}

runDeepSeekLogin({
  ...parseArgs(process.argv.slice(2)),
  onProgress: (message) => console.log(`[deepseek-login] ${message}`),
}).catch((error) => {
  console.error(`[deepseek-login] ${error?.message || String(error)}`);
  process.exitCode = 1;
});
