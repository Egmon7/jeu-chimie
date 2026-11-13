export default async function run(page) {
  await page.locator("#create-match").click();
  await page.waitForFunction(() => document.getElementById("screen-modes")?.hidden === false);
  const hasSettings = await page.locator("#go-settings").count();
  await page.screenshot({ path: "c:/projet_realiser/jeu_chimie/tests/shot-modes.png" });
  await page.locator("#go-solo").click();
  await page.waitForFunction(() => document.getElementById("screen-setup")?.hidden === false);
  const look = await page.evaluate(() => ({
    page: document.body.dataset.page,
    bg: getComputedStyle(document.body).backgroundColor,
    choice: getComputedStyle(document.querySelector("#setup-form .choices button")).backgroundColor,
    footer: getComputedStyle(document.querySelector(".site-footer")).display,
  }));
  await page.screenshot({ path: "c:/projet_realiser/jeu_chimie/tests/shot-setup.png" });
  return { hasSettings, look };
}
