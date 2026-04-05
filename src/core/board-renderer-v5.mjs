export function renderBoard(data){
  const tasks = data.tasks || []

  const counts = {
    blocked: tasks.filter(t=>t.status==='Blocked').length,
    overdue: tasks.filter(t=> new Date(t.due)<new Date() && t.status!=='Done').length,
    risk: tasks.filter(t=>t.status==='At Risk').length,
  }

  return `
  <h1>Board V5.1</h1>
  <div>Blocked: ${counts.blocked}</div>
  <div>Overdue: ${counts.overdue}</div>
  <div>At Risk: ${counts.risk}</div>
  `
}
