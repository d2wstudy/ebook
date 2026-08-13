import { createMarkdownRenderer, defineConfig } from 'vitepress'
import container from 'markdown-it-container'
import { bookConfig } from '../../book.config'
import { bookGroups, bookLanguages, bookPages } from './bookContent'
import {
  processSearchTerm,
  splitBookSearchSections,
  tokenizeSearchText,
} from './searchIndex'

function sidebarItems(group: string) {
  return bookPages
    .filter(page => page.group === group)
    .map(page => ({
      text: page.sidebarTitle,
      link: `/chapters/${page.slug}`,
    }))
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export default defineConfig({
  title: bookConfig.title,
  description: bookConfig.description,
  lang: 'zh-CN',
  base: bookConfig.base,

  transformPageData(pageData) {
    if (pageData.relativePath !== 'index.md') return
    const startLink = bookPages[0] ? `/chapters/${bookPages[0].slug}` : '/'
    pageData.frontmatter.hero = {
      name: bookConfig.title,
      text: bookConfig.description,
      tagline: '将 Markdown 放入语言目录，即可生成新的电子书项目',
      actions: [{ theme: 'brand', text: '开始阅读', link: startLink }],
    }
    pageData.frontmatter.features = [
      {
        title: '语言目录自动发现',
        details: 'content 下的语言目录会在构建时自动识别，单语言和多语言书籍使用同一套模板',
      },
      {
        title: '页面级语言切换',
        details: '每个页面集中渲染已有语言内容，缺少翻译时自动回退到可用语言',
      },
      {
        title: '阅读、标注与讨论',
        details: '复用划词笔记、章节评论、Reaction 和 GitHub Discussions 能力',
      },
    ]
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${bookConfig.base}favicon.svg` }],
  ],

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      ...(bookPages[0]
        ? [{ text: '开始阅读', link: `/chapters/${bookPages[0].slug}` }]
        : []),
    ],
    sidebar: bookGroups.map(group => ({
      text: group,
      items: sidebarItems(group),
    })),
    socialLinks: [
      { icon: 'github', link: `https://github.com/${bookConfig.github.owner}/${bookConfig.github.repo}` },
    ],
    outline: { level: [2, 3], label: '本页目录' },
    search: {
      provider: 'local',
      options: {
        detailedView: true,
        translations: {
          button: {
            buttonText: '搜索',
            buttonAriaLabel: '搜索全书',
          },
          modal: {
            displayDetails: '显示详细结果',
            resetButtonTitle: '清空搜索',
            backButtonTitle: '关闭搜索',
            noResultsText: '没有找到相关内容：',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换结果',
              navigateUpKeyAriaLabel: '向上箭头',
              navigateDownKeyAriaLabel: '向下箭头',
              closeText: '关闭',
              closeKeyAriaLabel: 'Escape',
            },
          },
        },
        miniSearch: {
          options: {
            tokenize: tokenizeSearchText,
            processTerm: processSearchTerm,
          },
          async _splitIntoSections(file, html) {
            const markdown = await createMarkdownRenderer('docs')
            return splitBookSearchSections(file, html, markdown)
          },
        },
      },
    },
  },

  markdown: {
    math: true,
    config: (md) => {
      const defaultImageRenderer = md.renderer.rules.image
      md.renderer.rules.image = (tokens, idx, options, env, self) => {
        tokens[idx].attrSet('loading', 'lazy')
        tokens[idx].attrSet('decoding', 'async')
        tokens[idx].attrSet('referrerpolicy', 'no-referrer')
        return defaultImageRenderer
          ? defaultImageRenderer(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options)
      }

      for (const language of bookLanguages) {
        const containerName = `reader-language-${language.replace(/[^A-Za-z0-9-]/g, '-')}`
        md.use(container, containerName, {
          render(tokens: any[], idx: number) {
            if (tokens[idx].nesting === 1) {
              const defaultAttribute = tokens[idx].info.trim().endsWith(' default')
                ? ' data-default-language="true"'
                : ''
              return `<section class="reader-language" data-language="${escapeAttribute(language)}"${defaultAttribute}>\n`
            }
            return '</section>\n'
          },
        })
      }

      md.use(container, 'notes', {
        render(tokens: any[], idx: number) {
          if (tokens[idx].nesting === 1) return '<div class="author-notes">\n'
          return '</div>\n'
        },
      })
    },
  },
})
