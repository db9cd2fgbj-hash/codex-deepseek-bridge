if (process.platform === "android") {
  Object.defineProperty(process, "platform", { value: "linux" });
}
