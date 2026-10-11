/** 页面底部的短暂提示 */

let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string): void {
  const t = document.getElementById('toast')!;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => (t.hidden = true), 2600);
}
