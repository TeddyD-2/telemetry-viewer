import SiteHeader from '../../components/SiteHeader.jsx';
import UploadForm from '../../components/UploadForm.jsx';
import SetupNotice from '../../components/SetupNotice.jsx';
import { teamMembers } from '../../lib/team.js';
import { missingConfig } from '../../lib/config.js';

export const dynamic = 'force-dynamic';

export default function UploadPage(){
  const missing = missingConfig();
  return (
    <>
      <SiteHeader sub="add a session" />
      <div className="wrap">
        <h1>Add a session</h1>
        <p className="lede">
          The CSV is parsed here in your browser, then uploaded along with a compact copy
          that opens without reparsing. Nothing is sent anywhere until you press Upload.
        </p>
        {missing.length ? <SetupNotice missing={missing} /> : <UploadForm members={teamMembers()} />}
      </div>
    </>
  );
}
