export interface BookConfig {
  id: string
  title: string
  description: string
  base: string
  contentDir: string
  defaultLanguage?: string
  languageNames?: Record<string, string>
  github: {
    owner: string
    repo: string
    workerUrl: string
  }
}

/** Public build-time settings for this book. Secrets stay in environment variables. */
export const bookConfig = {
  id: 'reader-template',
  title: '通用电子书模板',
  description: '支持自动发现语言目录的电子书阅读模板',
  base: '/reader-template/',
  contentDir: 'content',
  defaultLanguage: 'zh-CN',
  languageNames: {
    en: 'English',
    'zh-CN': '简体中文',
  },
  github: {
    owner: 'example',
    repo: 'reader-template',
    workerUrl: 'https://example.invalid/reader-worker',
  },
} satisfies BookConfig
