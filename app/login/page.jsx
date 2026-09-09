import LoginForm from '../../components/LoginForm.jsx';
import { teamMembers } from '../../lib/team.js';

export const dynamic = 'force-dynamic';

export default function LoginPage(){
  return (
    <div className="login">
      <LoginForm members={teamMembers()} />
    </div>
  );
}
