import { Icon } from "@/components/Icon";

export function WorkspaceWelcome({
  onCreate,
  onDiscover,
}: {
  onCreate: () => void;
  onDiscover: () => void;
}) {
  return (
    <div className="workspace-welcome">
      <div className="welcome-content">
        <div className="welcome-illustration" aria-hidden="true">
          <div className="welcome-node node-host">
            <Icon name="workspace" size={22} />
            <span>Host 主控</span>
          </div>
          <div className="welcome-connector" />
          <div className="welcome-nodes">
            <div className="welcome-node">
              <Icon name="terminal" size={20} />
              <span>Worker 执行</span>
            </div>
            <div className="welcome-node">
              <Icon name="book" size={20} />
              <span>知识库</span>
            </div>
          </div>
        </div>
        <h2>让你的 AI 团队，围绕项目协作</h2>
        <p>
          选择项目，配置主控，再加入需要的执行者。
          <br />
          任务、消息和知识留在同一个会话里。
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={onCreate}>
            <Icon name="plus" size={16} />
            新建协作
          </button>
          <button className="btn btn-secondary" onClick={onDiscover}>
            <Icon name="search" size={16} />
            打开已有协作
          </button>
        </div>
        <div className="welcome-steps">
          <div>
            <span>
              <Icon name="folder" size={19} />
            </span>
            <strong>绑定本地项目</strong>
            <p>让每个成员从同一个项目出发</p>
          </div>
          <div>
            <span>
              <Icon name="people" size={19} />
            </span>
            <strong>选择你的 AI 团队</strong>
            <p>本地模型与已有 CLI 均可加入</p>
          </div>
          <div>
            <span>
              <Icon name="shield" size={19} />
            </span>
            <strong>协作配置自动就绪</strong>
            <p>角色 Skill 与工具由系统准备</p>
          </div>
        </div>
      </div>
    </div>
  );
}
