module Tests.SnapshotTests.WaspBuildSnapshotTest (waspBuildSnapshotTest) where

import ShellCommands
  ( buildAndRemoveWaspProjectDockerImage,
    createSnapshotWaspProjectFromMinimalStarter,
    inSnapshotWaspProjectDir,
    setWaspDbToPSQL,
    waspCliBuild,
  )
import SnapshotTest (SnapshotTest, makeSnapshotTest, withWebAppBundleCheck)

waspBuildSnapshotTest :: SnapshotTest
waspBuildSnapshotTest =
  withWebAppBundleCheck $
    makeSnapshotTest
      "wasp-build"
      [ createSnapshotWaspProjectFromMinimalStarter,
        inSnapshotWaspProjectDir
          [ setWaspDbToPSQL,
            waspCliBuild,
            buildAndRemoveWaspProjectDockerImage
          ]
      ]
