import SiteHeader from '../components/SiteHeader.jsx';
import Library from '../components/Library.jsx';
import SetupNotice from '../components/SetupNotice.jsx';
import { missingConfig } from '../lib/config.js';

export const dynamic = 'force-dynamic';

export default function HomePage(){
  const missing = missingConfig();
  return (
    <>
      <SiteHeader />
      <div className="wrap">
        <h1>Sessions</h1>
        <p className="lede">
          Everything the team has shared. Open one to work through it in the viewer, or
          download the original CSV for RS3.
        </p>
        {missing.length ? <SetupNotice missing={missing} /> : <Library />}
      </div>
    </>
  );
}
