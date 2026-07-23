(() => {
  const passwordInput = document.getElementById("loginPassword");
  const toggleButton = document.getElementById("togglePasswordButton");

  if (!passwordInput || !toggleButton) return;

  toggleButton.addEventListener("click", () => {
    const shouldShowPassword = passwordInput.type === "password";

    passwordInput.type = shouldShowPassword ? "text" : "password";
    toggleButton.textContent = shouldShowPassword ? "Hide" : "Show";
    toggleButton.setAttribute("aria-pressed", shouldShowPassword ? "true" : "false");
    toggleButton.setAttribute(
      "aria-label",
      shouldShowPassword ? "Hide password" : "Show password"
    );
  });
})();
