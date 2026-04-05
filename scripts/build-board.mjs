import { renderBoard } from '../src/core/board-renderer-v5.mjs'
import fs from 'fs'

const data = JSON.parse(fs.readFileSync('./data.json','utf-8'))

const html = renderBoard(data)

fs.writeFileSync('./dist/index.html', html)
console.log('Board built with V5.1')
