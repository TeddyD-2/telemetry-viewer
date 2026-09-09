/* Who is on the team, for the uploader dropdown.

   A roster in an env var beats a free-text box: "teddy", "Teddy", "Teddy D" and "td"
   are four different people to a filter and one person in the paddock. Free text is
   still allowed, because the roster will always be a week out of date. */

export function teamMembers(){
  return (process.env.TEAM_MEMBERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
