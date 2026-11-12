interface Window {
  loopmarshalDesktop?: {
    customTitleBar: boolean;
    setWindowTheme(theme: "light" | "dark"): Promise<boolean>;
    getInfo(): Promise<{
      version: string;
      dataDirectory: string;
      cliPath: string;
      baseUrl: string;
      nodeVersion: string;
      packaged: boolean;
    }>;
    selectProjectDirectory(): Promise<string | null>;
    openDataDirectory(): Promise<string>;
    copyCliPath(): Promise<boolean>;
    openActivityWindow(sessionId: string, memberId?: string): Promise<boolean>;
    openConversationHistory(
      sessionId: string,
      memberId?: string,
    ): Promise<boolean>;
  };
}
