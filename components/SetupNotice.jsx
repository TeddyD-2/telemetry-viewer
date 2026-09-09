export default function SetupNotice({ missing }){
  return (
    <div className="err" style={{ display: 'grid', gap: 10 }}>
      <b>The shared library is not set up on this deployment yet.</b>
      <div>
        The viewer itself works regardless — <a href="/local">open a local CSV</a> and
        nothing here is needed. Sharing sessions needs these:
      </div>
      <table className="setup">
        <tbody>
          {missing.map(m => (
            <tr key={m.name}>
              <td><code>{m.name}</code></td>
              <td>{m.why}</td>
              <td><code>{m.how}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: '11.5px' }}>
        Full steps are in the README, under “Deploying”.
      </div>
    </div>
  );
}
