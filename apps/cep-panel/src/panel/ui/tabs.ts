export function activateTab(tabName: string): void {
  document.querySelectorAll<HTMLElement>(".main-tab-panel").forEach((panel) => {
    const active =
      panel.id === `mainTab${tabName[0].toUpperCase()}${tabName.slice(1)}`;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  document
    .querySelectorAll<HTMLButtonElement>(".main-tab-btn")
    .forEach((button) => {
      const active = button.id.toLowerCase().includes(tabName.toLowerCase());
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    });
}
