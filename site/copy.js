for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy)
      button.classList.add("copied")
      setTimeout(() => button.classList.remove("copied"), 1500)
    } catch {
      button.title = "Press Ctrl+C to copy"
    }
  })
}
