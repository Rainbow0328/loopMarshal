import { createLoopMarshalClient } from "@loopmarshal/sdk";
import { readCoreManagementToken } from "@loopmarshal/shared";

/** Resolve credentials per call so rotation does not require restarting stdio. */
export function createLocalClient() {
  return createLoopMarshalClient({
    headers: () => {
      const member = process.env.LOOPMARSHAL_MEMBER_TOKEN;
      const management = member ? null : readCoreManagementToken();
      return {
        "x-loopmarshal-client": "cli",
        "x-loopmarshal-process": String(process.pid),
        ...(member
          ? { authorization: `Bearer ${member}` }
          : management
            ? { "x-loopmarshal-management-token": management }
            : {}),
      };
    },
  });
}
