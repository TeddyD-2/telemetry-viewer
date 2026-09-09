import './viewer.css';
import './site.css';

export const metadata = {
  title: 'Cornell Racing — Telemetry Viewer',
  description: 'AiM telemetry viewer and shared session library',
};

export default function RootLayout({ children }){
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
