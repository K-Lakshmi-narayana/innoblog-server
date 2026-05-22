const MIN_ARTICLE_TAGS = 3
const MAX_ARTICLE_TAGS = 8
const MAX_ARTICLE_TAG_LENGTH = 50

const TAG_SUGGESTIONS_BY_DOMAIN = {
  ml: [
    'Machine Learning',
    'Model Evaluation',
    'Feature Engineering',
    'Recommendation Systems',
    'Responsible AI',
    'Model Monitoring',
    'Experiment Tracking',
    'AutoML',
    'Gradient Boosting',
    'Production ML',
    'Model Interpretability',
    'Synthetic Data',
    'Time Series',
    'Anomaly Detection',
    'Personalization',
    'Data Labeling',
  ],
  dl: [
    'Deep Learning',
    'Transformers',
    'Neural Networks',
    'Foundation Models',
    'Fine Tuning',
    'Model Compression',
    'GPU Training',
    'Distributed Training',
    'Attention Mechanisms',
    'Representation Learning',
    'Generative AI',
    'Diffusion Models',
    'Self Supervised Learning',
    'Optimization',
    'Quantization',
    'Training Stability',
  ],
  ds: [
    'Data Science',
    'Exploratory Analysis',
    'Business Metrics',
    'Dashboard Design',
    'Cohort Analysis',
    'Data Storytelling',
    'A/B Testing',
    'Forecasting',
    'Customer Analytics',
    'Data Cleaning',
    'SQL Analytics',
    'Experiment Design',
    'Product Analytics',
    'Visualization',
    'Decision Science',
    'Analytics Engineering',
  ],
  nlp: [
    'Natural Language Processing',
    'Large Language Models',
    'Prompt Engineering',
    'RAG',
    'Embeddings',
    'Semantic Search',
    'Text Classification',
    'Information Extraction',
    'Conversational AI',
    'Evaluation',
    'Agent Workflows',
    'Tokenization',
    'Knowledge Graphs',
    'Multilingual NLP',
    'Safety Guardrails',
    'Vector Databases',
  ],
  cv: [
    'Computer Vision',
    'Object Detection',
    'Image Segmentation',
    'Vision Transformers',
    'Multimodal AI',
    'OCR',
    'Video Analytics',
    'Image Classification',
    'Edge Vision',
    'Data Augmentation',
    'Pose Estimation',
    'Medical Imaging',
    'Visual Search',
    'Synthetic Images',
    'Annotation Strategy',
    'Model Deployment',
  ],
  mlops: [
    'MLOps',
    'Model Deployment',
    'CI/CD',
    'Feature Stores',
    'Model Registry',
    'Pipeline Orchestration',
    'Observability',
    'Data Drift',
    'Inference Scaling',
    'Batch Inference',
    'Real Time Serving',
    'Model Governance',
    'Cost Optimization',
    'Testing Strategy',
    'Rollback Strategy',
    'Infrastructure',
  ],
  stats: [
    'Statistics',
    'Bayesian Methods',
    'Causal Inference',
    'Hypothesis Testing',
    'Regression',
    'Sampling',
    'Uncertainty',
    'Experimental Design',
    'Survival Analysis',
    'Statistical Power',
    'Confidence Intervals',
    'Probability',
    'Missing Data',
    'Hierarchical Models',
    'Nonparametric Methods',
    'Effect Size',
  ],
}

function normalizeTagKey(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase()
}

function getTagSuggestionsForDomain(domain = '') {
  return TAG_SUGGESTIONS_BY_DOMAIN[normalizeTagKey(domain)] || []
}

function getAllowedTagMap(domain = '') {
  const suggestions = getTagSuggestionsForDomain(domain)

  return new Map(suggestions.map((tag) => [normalizeTagKey(tag), tag]))
}

function getKnownTagMap() {
  return new Map(
    Object.values(TAG_SUGGESTIONS_BY_DOMAIN)
      .flat()
      .map((tag) => [normalizeTagKey(tag), tag]),
  )
}

function resolveTagLabel(value, domain = '') {
  const normalized = normalizeTagKey(value)
  if (!normalized) {
    return ''
  }

  const domainTag = getAllowedTagMap(domain).get(normalized)
  if (domainTag) {
    return domainTag
  }

  return getKnownTagMap().get(normalized) || String(value).trim().replace(/\s+/g, ' ')
}

function getUnknownTags(tags = [], domain = '') {
  const allowedTags = getAllowedTagMap(domain)
  const rawTags = Array.isArray(tags) ? tags : String(tags).split(',')

  if (!allowedTags.size) {
    return []
  }

  return rawTags
    .map((tag) => String(tag || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .filter((tag) => !allowedTags.has(normalizeTagKey(tag)))
}

function rankTagSuggestions(domain = '', articleTags = []) {
  const suggestions = getTagSuggestionsForDomain(domain)
  const frequency = new Map()

  articleTags.flat().forEach((tag) => {
    const canonicalTag = resolveTagLabel(tag, domain)
    const key = normalizeTagKey(canonicalTag)

    if (suggestions.some((suggestion) => normalizeTagKey(suggestion) === key)) {
      frequency.set(key, (frequency.get(key) || 0) + 1)
    }
  })

  return [...suggestions].sort((left, right) => {
    const leftCount = frequency.get(normalizeTagKey(left)) || 0
    const rightCount = frequency.get(normalizeTagKey(right)) || 0

    if (leftCount !== rightCount) {
      return rightCount - leftCount
    }

    return suggestions.indexOf(left) - suggestions.indexOf(right)
  })
}

module.exports = {
  MAX_ARTICLE_TAG_LENGTH,
  MAX_ARTICLE_TAGS,
  MIN_ARTICLE_TAGS,
  TAG_SUGGESTIONS_BY_DOMAIN,
  getTagSuggestionsForDomain,
  getUnknownTags,
  normalizeTagKey,
  rankTagSuggestions,
  resolveTagLabel,
}
