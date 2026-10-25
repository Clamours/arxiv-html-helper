import { MAX_RATING } from '@/core/groups';
import { setRating } from '@/core/storage';
import { STAR_ICON } from './icons';

/**
 * 论文库和侧边栏共用：五星评分。点第 n 颗星评 n 星，再点当前星级清除；悬停时预览。
 * 写入后 watchLibrary 会触发重新渲染。
 */
export function ratingStars(paperId: string, rating: number): HTMLElement {
  const box = document.createElement('span');
  box.className = rating ? 'rating rated' : 'rating';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', rating ? `评分：${rating} 星` : '未评分');
  const stars: HTMLButtonElement[] = [];
  const show = (n: number) => stars.forEach((s, i) => s.classList.toggle('on', i < n));
  for (let n = 1; n <= MAX_RATING; n++) {
    const b = document.createElement('button');
    b.className = 'star';
    b.innerHTML = STAR_ICON;
    b.title = n === rating ? '清除评分' : `${n} 星`;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(n === rating));
    b.addEventListener('mouseenter', () => show(n));
    b.addEventListener('click', () => void setRating(paperId, n === rating ? 0 : n));
    stars.push(b);
  }
  box.addEventListener('mouseleave', () => show(rating));
  box.append(...stars);
  show(rating);
  return box;
}
