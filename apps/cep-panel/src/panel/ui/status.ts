export function setStatus(
  message: string,
  kind: "info" | "error" | "success" = "info",
): void {
  const element = document.getElementById("status");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-error", kind === "error");
  element.classList.toggle("is-success", kind === "success");
}
