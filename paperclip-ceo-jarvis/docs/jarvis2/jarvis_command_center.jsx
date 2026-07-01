import React, { useState, useEffect } from 'react';

export default function JARVISCommandCenter() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedAlert, setSelectedAlert] = useState(null);
  const [time, setTime] = useState(new Date());
  const [portfolioMetrics, setPortfolioMetrics] = useState({
    paperclip: { health: 82, users: 12400, revenue: 18500, status: 'shipping' },
    dbcode: { health: 65, users: 3200, revenue: 4200, status: 'in-progress' },
    phoenix: { health: 71, users: 8900, revenue: 2100, status: 'building' },
    pharma: { health: 68, users: 500, revenue: 0, status: 'research' }
  });

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const alerts = [
    { id: 1, severity: 'critical', title: 'DBCode: Deployment Pipeline Failure', desc: '2 consecutive failed CI/CD runs', action: 'View logs', timestamp: '2 min ago' },
    { id: 2, severity: 'high', title: 'Kubernetes Resource Spike', desc: 'Paperclip Ultimate: 300% memory usage spike', action: 'Investigate', timestamp: '15 min ago' },
    { id: 3, severity: 'info', title: 'Phoenix Growth', desc: '15% daily active user increase', action: 'Celebrate', timestamp: '1 hour ago' },
    { id: 4, severity: 'high', title: 'Market Opportunity', desc: 'Competitor vulnerability window: 2 weeks', action: 'Strategize', timestamp: '3 hours ago' },
  ];

  const decisions = [
    { id: 1, title: 'Hermes v2 Architecture Approval', context: 'New reasoning engine design ready', priority: 'urgent', owner: 'Hermes Agent' },
    { id: 2, title: 'UK Market Entry Timing', context: 'Market ready, funding available, competitive window open', priority: 'urgent', owner: 'OpenClaw Intel' },
    { id: 3, title: 'Senior Backend Engineer Hiring', context: '3 candidates qualified, offer pending', priority: 'high', owner: 'Minerva Recruitment' },
  ];

  const agents = [
    { name: 'Hermes', role: 'Strategic Reasoning', status: 'active', lastAction: '2 min ago', quality: 94 },
    { name: 'OpenClaw', role: 'Market Intelligence', status: 'active', lastAction: '5 min ago', quality: 87 },
    { name: 'Pi', role: 'Code Execution', status: 'active', lastAction: '10 sec ago', quality: 91 },
    { name: 'Minerva', role: 'Technical Strategy', status: 'active', lastAction: '1 hour ago', quality: 89 },
  ];

  const renderHealthBar = (value) => {
    const color = value >= 80 ? '#0F6E56' : value >= 65 ? '#BA7517' : '#A32D2D';
    return (
      <div style={{ width: '100%', height: '8px', background: 'var(--color-background-secondary)', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, transition: 'width 0.3s' }}></div>
      </div>
    );
  };

  const SeverityBadge = ({ severity }) => {
    const colors = {
      critical: { bg: '#FCEBEB', text: '#A32D2D' },
      high: '#FFF5E5',
      info: '#E6F1FB',
    };
    const styles = {
      critical: { bg: '#FCEBEB', text: '#A32D2D' },
      high: { bg: '#FFF5E5', text: '#BA7517' },
      info: { bg: '#E6F1FB', text: '#185FA5' },
    };
    const style = styles[severity] || styles.info;
    return (
      <span style={{ background: style.bg, color: style.text, padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase' }}>
        {severity}
      </span>
    );
  };

  return (
    <div style={{ background: 'var(--color-background-tertiary)', minHeight: '100vh', padding: 0 }}>
      {/* Header */}
      <div style={{ background: 'var(--color-background-primary)', borderBottom: '1px solid var(--color-border-tertiary)', padding: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ width: '48px', height: '48px', background: 'linear-gradient(135deg, #FF6B35, #F7931E)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: '24px', fontWeight: 600 }}>J</div>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 600, margin: 0, color: 'var(--color-text-primary)' }}>JARVIS</h1>
            <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>CEO Command Center • Always Active</p>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)' }}>System Time</div>
          <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--color-text-primary)', fontFamily: 'monospace' }}>
            {time.toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div style={{ background: 'var(--color-background-primary)', borderBottom: '1px solid var(--color-border-tertiary)', padding: '0 1.5rem', display: 'flex', gap: '2rem' }}>
        {['dashboard', 'portfolio', 'decisions', 'agents', 'analytics', 'briefing'].map(tab => (
          <button key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '12px 0',
              border: 'none',
              background: 'none',
              color: activeTab === tab ? 'var(--color-text-info)' : 'var(--color-text-secondary)',
              borderBottom: activeTab === tab ? '2px solid var(--color-text-info)' : 'none',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              textTransform: 'capitalize',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ padding: '2rem' }}>
        {activeTab === 'dashboard' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
            {/* Critical Alerts */}
            <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '1.5rem', gridColumn: '1 / -1' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 1rem', color: 'var(--color-text-primary)' }}>Critical Alerts & Intelligence</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {alerts.map(alert => (
                  <div key={alert.id}
                    onClick={() => setSelectedAlert(alert.id)}
                    style={{
                      background: 'var(--color-background-secondary)',
                      border: `1px solid var(--color-border-tertiary)`,
                      borderLeft: `4px solid ${alert.severity === 'critical' ? '#A32D2D' : alert.severity === 'high' ? '#BA7517' : '#185FA5'}`,
                      borderRadius: '4px',
                      padding: '12px',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseOver={(e) => e.currentTarget.style.borderColor = 'var(--color-border-secondary)'}
                    onMouseOut={(e) => e.currentTarget.style.borderColor = 'var(--color-border-tertiary)'}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '8px' }}>
                      <div>
                        <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>{alert.title}</p>
                        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0 0' }}>{alert.desc}</p>
                      </div>
                      <SeverityBadge severity={alert.severity} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{alert.timestamp}</span>
                      <button style={{ background: 'transparent', border: 'none', color: 'var(--color-text-info)', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
                        {alert.action} →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Decisions Pending */}
            <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '1.5rem', gridColumn: 'span 2' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 1rem', color: 'var(--color-text-primary)' }}>Decisions Pending Your Input</h2>
              {decisions.map(decision => (
                <div key={decision.id} style={{ padding: '1rem', borderBottom: '1px solid var(--color-border-tertiary)', display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>{decision.title}</p>
                    <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: '4px 0' }}>{decision.context}</p>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', margin: 0 }}>Owner: {decision.owner}</p>
                  </div>
                  <span style={{ background: decision.priority === 'urgent' ? '#FCEBEB' : '#FFF5E5', color: decision.priority === 'urgent' ? '#A32D2D' : '#BA7517', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 600 }}>
                    {decision.priority}
                  </span>
                </div>
              ))}
            </div>

            {/* Agent Network Status */}
            <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '1.5rem' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 1rem', color: 'var(--color-text-primary)' }}>Agent Network</h2>
              {agents.map(agent => (
                <div key={agent.name} style={{ padding: '12px 0', borderBottom: '1px solid var(--color-border-tertiary)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                    <p style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>{agent.name}</p>
                    <span style={{ fontSize: '11px', color: '#0F6E56', fontWeight: 600 }}>●</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0 }}>{agent.role}</p>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', margin: 0 }}>Quality: {agent.quality}%</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'portfolio' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
            {Object.entries(portfolioMetrics).map(([key, metrics]) => (
              <div key={key} style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '1.5rem' }}>
                <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 1rem', color: 'var(--color-text-primary)', textTransform: 'capitalize' }}>
                  {key === 'paperclip' ? 'Paperclip Ultimate' : key === 'dbcode' ? 'DBCode' : key === 'phoenix' ? 'PhoenixRisingAI' : 'Pharmacognostical DB'}
                </h3>

                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>Health</span>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{metrics.health}%</span>
                  </div>
                  {renderHealthBar(metrics.health)}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div style={{ background: 'var(--color-background-secondary)', padding: '12px', borderRadius: '4px' }}>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: 0 }}>Users</p>
                    <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '4px 0 0' }}>{metrics.users.toLocaleString()}</p>
                  </div>
                  <div style={{ background: 'var(--color-background-secondary)', padding: '12px', borderRadius: '4px' }}>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: 0 }}>MRR</p>
                    <p style={{ fontSize: '16px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '4px 0 0' }}>£{(metrics.revenue / 1000).toFixed(1)}K</p>
                  </div>
                </div>

                <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--color-border-tertiary)' }}>
                  <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: '0 0 6px', textTransform: 'uppercase', fontWeight: 600 }}>Status</p>
                  <p style={{ fontSize: '12px', color: 'var(--color-text-primary)', margin: 0, textTransform: 'capitalize' }}>{metrics.status}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'decisions' && (
          <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '2rem', maxWidth: '800px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 2rem', color: 'var(--color-text-primary)' }}>Strategic Decisions Framework</h2>
            {decisions.map((decision, idx) => (
              <div key={decision.id} style={{ marginBottom: idx < decisions.length - 1 ? '2rem' : 0, paddingBottom: idx < decisions.length - 1 ? '2rem' : 0, borderBottom: idx < decisions.length - 1 ? '1px solid var(--color-border-tertiary)' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>{decision.title}</h3>
                  <span style={{ background: decision.priority === 'urgent' ? '#FCEBEB' : '#FFF5E5', color: decision.priority === 'urgent' ? '#A32D2D' : '#BA7517', padding: '4px 12px', borderRadius: 'var(--border-radius-md)', fontSize: '11px', fontWeight: 600 }}>
                    {decision.priority}
                  </span>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0 }}>{decision.context}</p>
                <p style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', margin: '8px 0 0' }}>Submitted by: {decision.owner}</p>
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                  <button style={{ padding: '8px 16px', background: 'var(--color-text-info)', color: 'white', border: 'none', borderRadius: 'var(--border-radius-md)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                    Approve
                  </button>
                  <button style={{ padding: '8px 16px', background: 'transparent', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: 'var(--border-radius-md)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                    Request More Info
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'agents' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '1.5rem' }}>
            {agents.map(agent => (
              <div key={agent.name} style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--color-text-primary)', margin: 0 }}>{agent.name}</h3>
                  <span style={{ width: '12px', height: '12px', background: '#0F6E56', borderRadius: '50%', display: 'inline-block' }}></span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Role</p>
                    <p style={{ fontSize: '13px', color: 'var(--color-text-primary)', margin: '4px 0 0' }}>{agent.role}</p>
                  </div>
                  <div>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Quality Score</p>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                      <div style={{ flex: 1, height: '6px', background: 'var(--color-background-secondary)', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${agent.quality}%`, height: '100%', background: '#0F6E56' }}></div>
                      </div>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{agent.quality}%</span>
                    </div>
                  </div>
                  <div>
                    <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Last Action</p>
                    <p style={{ fontSize: '13px', color: 'var(--color-text-primary)', margin: '4px 0 0' }}>{agent.lastAction}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'analytics' && (
          <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '2rem' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 600, margin: '0 0 2rem', color: 'var(--color-text-primary)' }}>System Analytics</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
              <div style={{ background: 'var(--color-background-secondary)', padding: '1.5rem', borderRadius: 'var(--border-radius-md)' }}>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Decision Accuracy</p>
                <p style={{ fontSize: '28px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '12px 0 0' }}>94.2%</p>
              </div>
              <div style={{ background: 'var(--color-background-secondary)', padding: '1.5rem', borderRadius: 'var(--border-radius-md)' }}>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Alert Precision</p>
                <p style={{ fontSize: '28px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '12px 0 0' }}>87.6%</p>
              </div>
              <div style={{ background: 'var(--color-background-secondary)', padding: '1.5rem', borderRadius: 'var(--border-radius-md)' }}>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Avg Response Time</p>
                <p style={{ fontSize: '28px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '12px 0 0' }}>2.3s</p>
              </div>
              <div style={{ background: 'var(--color-background-secondary)', padding: '1.5rem', borderRadius: 'var(--border-radius-md)' }}>
                <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', margin: 0, textTransform: 'uppercase', fontWeight: 600 }}>Uptime</p>
                <p style={{ fontSize: '28px', fontWeight: 600, color: 'var(--color-text-primary)', margin: '12px 0 0' }}>99.98%</p>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'briefing' && (
          <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-tertiary)', borderRadius: 'var(--border-radius-lg)', padding: '2rem', maxWidth: '900px', fontFamily: 'var(--font-serif)' }}>
            <div style={{ fontSize: '14px', color: 'var(--color-text-secondary)', marginBottom: '2rem' }}>
              DAILY STRATEGIC BRIEFING • {time.toLocaleDateString()}
            </div>

            <h2 style={{ fontSize: '18px', fontWeight: 500, margin: '0 0 1.5rem', color: 'var(--color-text-primary)' }}>Good Morning, Sir/Madam</h2>

            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '1.5rem 0 1rem', color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>Three Things to Know Today</h3>
            <ul style={{ fontSize: '13px', color: 'var(--color-text-primary)', margin: 0, paddingLeft: '1.5rem' }}>
              <li style={{ marginBottom: '8px' }}>DBCode deployment pipeline requires immediate attention—two consecutive failed runs require diagnosis</li>
              <li style={{ marginBottom: '8px' }}>Competitive window for UK market entry closing in 14 days—strategic decision point this week</li>
              <li style={{ marginBottom: '8px' }}>PhoenixRisingAI momentum accelerating (15% daily user growth)—scaling opportunity emerging</li>
            </ul>

            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '1.5rem 0 1rem', color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>Portfolio Status</h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.7 }}>
              Paperclip Ultimate remains our strongest performer at 82% health with steady revenue growth. DBCode requires tactical intervention on CI/CD—Minerva has recommended architecture adjustments. PhoenixRisingAI has achieved inflection point on user adoption. Pharmacognostical database progresses steadily on research milestones.
            </p>

            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '1.5rem 0 1rem', color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>Decisions Requiring Your Input</h3>
            <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', margin: 0, lineHeight: 1.7 }}>
              Three major decisions are pending: (1) Hermes v2 reasoning engine architecture, with my recommendation to proceed immediately given our competitive position; (2) UK market entry timing, with a 2-week window before competitive threat closes; (3) Senior backend engineer hiring, with three qualified candidates available.
            </p>

            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '1.5rem 0 1rem', color: 'var(--color-text-primary)', textTransform: 'uppercase' }}>Shall I elaborate on any of these matters, sir/madam?</h3>
          </div>
        )}
      </div>
    </div>
  );
}
