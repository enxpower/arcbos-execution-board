import fs from 'fs'
import path from 'path'
import { renderBoard } from '../src/core/board-renderer-v5.mjs'

const DATA_PATH = './data.json'

// 👇 fallback 数据（关键）
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

function main() {
  const data = loadData()

  const html = renderBoard(data)

  fs.writeFileSync('./dist/index.html', html)
  console.log('✅ Board built')
}

main()