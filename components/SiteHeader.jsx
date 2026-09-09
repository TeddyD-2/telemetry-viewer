import Link from 'next/link';
import LogoutButton from './LogoutButton.jsx';

export default function SiteHeader({ sub }){
  return (
    <header className="sitehead">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.webp" alt="Cornell Racing" />
      <div>
        <div className="title">Telemetry Viewer</div>
        <div className="sub">{sub || 'shared session library'}</div>
      </div>
      <nav>
        <Link className="btn" href="/">Library</Link>
        <Link className="btn" href="/local">Open a local file</Link>
        <Link className="btn primary" href="/upload">Add a session</Link>
        <LogoutButton />
      </nav>
    </header>
  );
}
