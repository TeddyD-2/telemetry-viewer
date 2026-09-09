import SiteHeader from '../../components/SiteHeader.jsx';
import UploadForm from '../../components/UploadForm.jsx';
import SetupNotice from '../../components/SetupNotice.jsx';
import { missingConfig } from '../../lib/config.js';
import { currentUser } from '../../lib/session.js';

export const dynamic = 'force-dynamic';

export default async function UploadPage(){
  const missing = missingConfig();
  const me = await currentUser();
  return (
    <>
      <SiteHeader sub="add a session" />
      <div className="wrap">
        <h1>Add a session</h1>
        <p className="lede">
          The CSV is parsed here in your browser, then uploaded along with a compact copy
          that opens without reparsing. Nothing is sent anywhere until you press Upload.
        </p>
        {missing.length ? <SetupNotice missing={missing} /> : <UploadForm me={me} />}
      </div>
    </>
  );
}
