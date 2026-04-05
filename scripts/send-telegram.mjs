import fetch from 'node-fetch'
import fs from 'fs'

const BOT_TOKEN = process.env.BOT_TOKEN
const CHAT_ID = process.env.CHAT_ID

const data = JSON.parse(fs.readFileSync('./data.json','utf-8'))

async function send(msg){
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id:CHAT_ID,text:msg,parse_mode:'Markdown'})
  })
}

const tasks = data.tasks || []

for(const t of tasks){
  if(t.status==='Blocked'){
    await send(`🚫 Blocked: ${t.name}`)
  }
  if(new Date(t.due)<new Date() && t.status!=='Done'){
    await send(`⏰ Overdue: ${t.name}`)
  }
}

console.log('Telegram sent')
