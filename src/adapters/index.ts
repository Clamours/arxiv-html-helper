import type { TranslationAdapter } from '@/core/context';

/**
 * 选择器来自对插件发布包的分析（沉浸式翻译 1.33.3、陪读蛙 1.48.1），详见 docs/translators.md。
 * 插件升级改了类名时只需改这里。
 */

/**
 * 沉浸式翻译
 * 双语：<p data-imt-p="1">原文<font class="notranslate immersive-translate-target-wrapper"><br><font …block-wrapper><font …target-inner>译文</font></font></font></p>
 * 仅译文：原文文本节点被改写，段落上加 data-imt-translation-only="1"
 */
export const immersiveTranslate: TranslationAdapter = {
  id: 'immersive-translate',
  name: '沉浸式翻译',
  wrapperSelector: '.immersive-translate-target-wrapper',
  inPlaceSelector: '[data-imt-translation-only]',
  ignoreSelector: '[data-immersive-translate-loading-id]',
};

/**
 * 陪读蛙
 * 双语：<p>原文<span class="notranslate read-frog-translated-content-wrapper"><br><span class="read-frog-translated-block-content">译文</span></span></p>
 * 仅译文：原文文本节点被改写，"最后一个原文节点的父元素"上加 data-read-frog-translation-only
 */
export const readFrog: TranslationAdapter = {
  id: 'read-frog',
  name: '陪读蛙',
  wrapperSelector: '.read-frog-translated-content-wrapper',
  inPlaceSelector: '[data-read-frog-translation-only]',
  ignoreSelector: '.read-frog-spinner, .read-frog-translation-error-container',
};

export const ADAPTERS: TranslationAdapter[] = [immersiveTranslate, readFrog];
