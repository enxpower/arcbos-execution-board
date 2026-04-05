import fs from 'fs'
import path from 'path'
import { renderBoard } from '../src/core/board-renderer-v5.mjs'

const DATA_PATH = './data.json'
const OUTPUT_DIR = './dist'
const OUTPUT_FILE = './dist/index.html'

// fallback 数据
const fallbackData = {
  tasks: [],
  phases: [],
  milestones: []
}

function loadData() {
  if (fs.existsSync(DATA_PATH)) {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'))
  } else {
    console.warn('⚠️ data.json not found, using fallback')
    return fallbackData
  }
}

function ensureDist() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  }
}

function main() {
  const data = loadData()

  const html = renderBoard(data)

  // ✅ 关键：先创建目录
  ensureDist()

  fs.writeFileSync(OUTPUT_FILE, html)

  console.log('✅ Board built successfully')
}

main()