import { bookPages, pageContent } from '../.vitepress/bookContent'

export default {
  paths() {
    return bookPages.map(page => ({
      params: { chapter: page.slug },
      content: pageContent(page),
    }))
  },
}
