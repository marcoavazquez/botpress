import _ from 'lodash'
import axios from 'axios'
import ms from 'ms'

const QUESTIONS_CACHE_TIMEOUT = ms('10 sec')
const KNOWLEDGEBASE_NAME = 'botpress'

// Handles QnA Maker API downcasing all key-values in metadata
const markUpperCase = str => str.replace(/([A-Z])/g, 'sssooo$1sss')
const restoreUpperCase = str =>
  str
    .split('sss')
    .map(chunk => (chunk.startsWith('ooo') ? chunk.slice(3).toUpperCase() : chunk))
    .join('')
const keysToRestore = { redirectflow: 'redirectFlow', redirectnode: 'redirectNode' }

const qnaItemData = ({ questions, answer, metadata }) => ({
  questions,
  answer,
  ..._.fromPairs(metadata.map(({ name, value }) => [keysToRestore[name] || name, restoreUpperCase(value)])),
  enabled: (metadata.find(({ name }) => name === 'enabled') || {}).value === 'true'
})

const prepareMeta = data =>
  _.chain(data)
    .pick(['enabled', 'action', 'redirectFlow', 'redirectNode'])
    .toPairs()
    .map(([name, value]) => ({ name, value: _.isString(value) ? markUpperCase(value) : value }))
    .filter(({ value }) => !_.isUndefined(value) && value !== '')
    .value()

export default class Storage {
  constructor({ bp, config }) {
    const baseURL = 'https://westus.api.cognitive.microsoft.com/qnamaker/v4.0'
    const headers = { 'Ocp-Apim-Subscription-Key': config.microsoftQnaMakerApiKey }
    Object.assign(this, { bp, client: axios.create({ baseURL, headers }) })
  }

  async initialize() {
    const isBpKnowledgbase = ({ name }) => name === KNOWLEDGEBASE_NAME
    const { data: { knowledgebases: initialKnowledgebases } } = await this.client.get('/knowledgebases/')
    const existingKb = initialKnowledgebases.find(isBpKnowledgbase)
    if (existingKb) {
      this.knowledgebase = existingKb
    } else {
      await this.client.post('/knowledgebases/create', { name: KNOWLEDGEBASE_NAME, qnaList: [], urls: [], files: [] })
      this.knowledgebase = (await this.client.get('/knowledgebases/')).find(isBpKnowledgbase)
    }

    this.endpointKey = (await this.client.get('/endpointkeys')).data.primaryEndpointKey
  }

  publish = () => this.client.post(`/knowledgebases/${this.knowledgebase.id}`)

  patchKb = params => this.client.patch(`/knowledgebases/${this.knowledgebase.id}`, params)

  async update(data, id) {
    const prevData = await this.getQuestion(id)
    const questionsChanged = _.isEqual(data.questions, prevData.questions)
    await this.patchKb({
      update: {
        qnaList: [
          {
            id,
            answer: data.answer,
            ...(questionsChanged ? {} : { questions: { add: data.questions, delete: prevData.questions } }),
            metadata: { delete: prevData.metadata, add: prepareMeta(data) }
          }
        ]
      }
    })

    this.invalidateCache()
    await this.publish()
    return id
  }

  async insert(qna) {
    const qnas = _.isArray(qna) ? qna : [qna]
    await this.patchKb({
      add: {
        qnaList: qnas.map(qna => ({ id: 0, ..._.pick(qna, ['answer', 'questions']), metadata: prepareMeta(qna) }))
      }
    })
    this.invalidateCache()
    await this.publish()
    // TODO: should return ids (for consistency)
  }

  async fetchQuestions() {
    if (!this.questions) {
      // || new Date() - this.questionsCached > QUESTIONS_CACHE_TIMEOUT) {
      const { data: { qnaDocuments } } = await this.client.get(`/knowledgebases/${this.knowledgebase.id}/test/qna/`)
      this.questions = qnaDocuments
      this.questionsCached = new Date()
    }

    return this.questions
  }

  invalidateCache = () => (this.questions = null)

  async getQuestion(id) {
    const questions = await this.fetchQuestions()
    return questions.find(({ id: qnaId }) => qnaId == id)
  }

  async count() {
    const questions = await this.fetchQuestions()
    return questions.length
  }

  async all({ limit, offset } = {}) {
    let questions = await this.fetchQuestions()
    if (typeof limit !== 'undefined' && typeof offset !== 'undefined') {
      questions = questions.slice(offset, offset + limit)
    }

    return questions.map(qna => ({ id: qna.id, data: qnaItemData(qna) }))
  }

  async answersOn(question) {
    const { data: { answers } } = await axios.post(
      `/qnamaker/knowledgebases/${this.knowledgebase.id}/generateAnswer`,
      { question },
      { baseURL: this.knowledgebase.hostName, headers: { Authorization: `EndpointKey ${this.endpointKey}` } }
    )

    return _.orderBy(answers, ['confidence'], ['desc']).map(answer => ({
      ..._.pick(answer, ['questions', 'answer', 'id']),
      confidence: answer.score,
      ...qnaItemData(answer)
    }))
  }

  async delete(id) {
    const ids = _.isArray(id) ? id : [id]
    await this.client.patch(`/knowledgebases/${this.knowledgebase.id}`, { delete: { ids } })
    this.invalidateCache()
    await this.publish()
  }
}
