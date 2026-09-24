/** 相对 URL 同时适用于独立服务与工作区代理前缀，不需要平台 SDK。 */
const note = document.querySelector("#note");
const status = document.querySelector("#status");
async function request(init) {
  const response = await fetch("./api/note", init);
  if (!response.ok) throw Error(`请求失败（${response.status}）`);
  return response.json();
}
try {
  note.value = (await request()).note;
  status.textContent = "已读取当前工作区的笔记";
} catch (error) {
  status.textContent = error.message;
}
document.querySelector("#editor").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await request({
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note.value }),
    });
    status.textContent = "已保存";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
