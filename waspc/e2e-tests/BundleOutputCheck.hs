module BundleOutputCheck
  ( checkWebAppBundleOutput,
    bundleOutputCheckSpec,
  )
where

import Control.Exception (bracket_)
import Data.Aeson ((.:))
import qualified Data.Aeson as Aeson
import Data.Aeson.Types (parseMaybe)
import qualified Data.ByteString as BS
import Data.Char (isAlpha, isAlphaNum, isSpace, toLower)
import Data.List (dropWhileEnd, isInfixOf, isPrefixOf, isSuffixOf, stripPrefix)
import Data.Maybe (fromMaybe)
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import qualified Data.Text.Encoding.Error as TEE
import System.Directory
  ( createDirectoryIfMissing,
    doesFileExist,
    getFileSize,
    getTemporaryDirectory,
    removePathForcibly,
  )
import System.FilePath (makeRelative, splitDirectories, takeDirectory, (</>))
import System.Process (getCurrentPid)
import Test.Hspec (Spec, describe, it, shouldBe, shouldSatisfy)

-- | Structural checks for the Vite output of @wasp build@ in
-- @.wasp/out/web-app@. Snapshot comparison skips @build@ and @build-ssr@
-- because their names and contents are content hashes (see
-- 'SnapshotTest.isBundlerOutputDir'), so this asserts what must hold
-- regardless of hashes: a non-empty @build/index.html@ whose local
-- @\<script src\>@ and @\<link href\>@ JS/CSS references resolve, under the
-- app's Vite base path (Wasp's @client.baseDir@, @/@ by default), to
-- non-empty files inside @build/@, at least one of them a script, and, when
-- @ssr.json@ enables SSR, a non-empty SSR entry and server. Returns one
-- message per problem; empty means it passed.
checkWebAppBundleOutput :: String -> FilePath -> IO [String]
checkWebAppBundleOutput basePath webAppDir = (++) <$> checkClientBuild <*> checkSsrBuild
  where
    buildDir = webAppDir </> "build"
    indexHtml = buildDir </> "index.html"

    checkClientBuild :: IO [String]
    checkClientBuild = do
      indexErrors <- checkNonEmptyFile indexHtml
      if not (null indexErrors)
        then return indexErrors
        else do
          references <- assetReferences . decodeUtf8 <$> BS.readFile indexHtml
          referenceErrors <- concat <$> mapM (checkReference . snd) references
          let missingScript =
                [ "build/index.html has no <script> with a local src"
                  | not (any (\(tag, reference) -> tag == ScriptTag && isScript reference) references)
                ]
          return (missingScript ++ referenceErrors)

    checkReference :: String -> IO [String]
    checkReference reference = case resolveReference basePath reference of
      Left problem -> return ["build/index.html " ++ problem ++ ": " ++ reference]
      Right path -> checkNonEmptyFile (buildDir </> path)

    checkSsrBuild :: IO [String]
    checkSsrBuild = do
      let ssrManifest = webAppDir </> "ssr.json"
      manifestExists <- doesFileExist ssrManifest
      if not manifestExists
        then return ["missing ssr.json"]
        else do
          decoded <- Aeson.decodeFileStrict ssrManifest :: IO (Maybe Aeson.Value)
          case decoded >>= parseMaybe (Aeson.withObject "ssr.json" (.: "enabled")) of
            Nothing -> return ["ssr.json has no boolean \"enabled\" field"]
            Just False -> return []
            Just True ->
              concat
                <$> mapM
                  checkNonEmptyFile
                  [webAppDir </> "build-ssr" </> "entry-server.js", webAppDir </> "server-ssr.mjs"]

    checkNonEmptyFile :: FilePath -> IO [String]
    checkNonEmptyFile path = do
      exists <- doesFileExist path
      if not exists
        then return ["missing " ++ relativePath path]
        else do
          size <- getFileSize path
          return ["empty " ++ relativePath path | size == 0]

    relativePath :: FilePath -> FilePath
    relativePath = makeRelative webAppDir

    decodeUtf8 :: BS.ByteString -> T.Text
    decodeUtf8 = TE.decodeUtf8With TEE.lenientDecode

isScript :: String -> Bool
isScript reference = any (`isSuffixOf` map toLower reference) [".js", ".mjs"]

-- | Maps a reference from @index.html@ to a path inside @build/@. Absolute
-- references must start with the base path; relative ones resolve against
-- @index.html@ at the build root. Nothing may escape @build/@.
resolveReference :: String -> String -> Either String FilePath
resolveReference basePath reference
  | base `isPrefixOf` reference = insideBuild (drop (length base) reference)
  | "/" `isPrefixOf` reference = Left ("references a path outside the base path " ++ base)
  | otherwise = insideBuild (fromMaybe reference (stripPrefix "./" reference))
  where
    base = "/" ++ dropWhile (== '/') (dropWhileEnd (== '/') basePath ++ "/")
    insideBuild path
      | ".." `elem` splitDirectories path = Left "references a path outside build/"
      | otherwise = Right path

data AssetTag = ScriptTag | LinkTag
  deriving (Eq)

-- | Values of @src@ on @\<script\>@ and @href@ on @\<link\>@ tags that name a
-- local .js, .mjs or .css file, with any query or fragment removed, tagged
-- with the element they came from (a @modulepreload@ link is not a script).
-- Tags are scanned with quoted attribute values respected (a quoted @<@ or
-- @>@ neither starts nor ends a tag); comments and the raw text of
-- @\<script\>@ and @\<style\>@ elements are skipped; tag and attribute names
-- are case-insensitive; values may be double-quoted, single-quoted or
-- unquoted, with optional whitespace around @=@. External URLs and data URIs
-- are skipped.
assetReferences :: T.Text -> [(AssetTag, String)]
assetReferences html =
  [ (tag, reference)
    | (tagName, tagAttributes) <- tags html,
      (tag, wantedAttribute) <- case tagName of
        "script" -> [(ScriptTag, "src")]
        "link" -> [(LinkTag, "href")]
        _ -> [],
      (name, value) <- tagAttributes,
      name == wantedAttribute,
      Just reference <- [localAsset value]
  ]
  where
    -- Start tags as (lowercased name, attributes), in document order.
    tags :: T.Text -> [(T.Text, [(T.Text, T.Text)])]
    tags text = case T.breakOn "<" text of
      (_, rest)
        | T.null rest -> []
        | "<!--" `T.isPrefixOf` rest -> tags (T.drop 3 (snd (T.breakOn "-->" (T.drop 4 rest))))
        | not (startsTag (T.drop 1 rest)) -> tags (T.drop 1 rest)
        | otherwise -> (tagName, tagAttributes) : tags (skipRawText tagName afterTag)
        where
          (name, afterName) = T.span isAlphaNum (T.drop 1 rest)
          tagName = T.toLower name
          (tagAttributes, afterTag) = attributes afterName
          -- A @<@ not followed by a tag name or end tag is text (e.g. @1 < 2@).
          startsTag afterLessThan = case T.uncons afterLessThan of
            Just (char, _) -> isAlpha char || char == '/'
            Nothing -> False

    -- The contents of script and style elements are not markup: skip to the
    -- matching end tag (@</script@ followed by whitespace, @/@, @>@ or the end).
    skipRawText :: T.Text -> T.Text -> T.Text
    skipRawText tagName text
      | tagName `elem` ["script", "style"] = findEndTag text
      | otherwise = text
      where
        endTag = "</" <> tagName
        -- Lowercase per character so offsets match the original text.
        findEndTag remaining = case T.breakOn endTag (T.map toLower remaining) of
          (before, match)
            | T.null match -> ""
            | isEndTagBoundary (T.drop (T.length endTag) match) -> T.drop (T.length before) remaining
            | otherwise -> findEndTag (T.drop (T.length before + T.length endTag) remaining)
        isEndTagBoundary afterName = case T.uncons afterName of
          Nothing -> True
          Just (char, _) -> isSpace char || char `elem` ['/', '>']

    -- Attributes up to the unquoted @>@ closing the tag, and the text after it.
    attributes :: T.Text -> ([(T.Text, T.Text)], T.Text)
    attributes text
      | T.null rest = ([], rest)
      | ">" `T.isPrefixOf` rest = ([], T.drop 1 rest)
      | otherwise = ((T.toLower name, value) : moreAttributes, afterTag)
      where
        rest = T.dropWhile isAttributeSeparator text
        (name, afterName) = T.span (\char -> not (isSpace char) && char `notElem` ['=', '/', '>']) rest
        afterSpaces = T.dropWhile isSpace afterName
        (value, remaining) = case T.uncons afterSpaces of
          Just ('=', afterEquals) -> attributeValue (T.dropWhile isSpace afterEquals)
          _ -> ("", afterSpaces)
        (moreAttributes, afterTag) = attributes remaining
        isAttributeSeparator char = isSpace char || char == '/'

    attributeValue :: T.Text -> (T.Text, T.Text)
    attributeValue text = case T.uncons text of
      Just (quote, rest) | quote `elem` ['"', '\''] -> T.drop 1 <$> T.break (== quote) rest
      _ -> T.break (\char -> isSpace char || char == '>') text

    localAsset :: T.Text -> Maybe String
    localAsset value
      | any (`isPrefixOf` lowerReference) ["http:", "https:", "//", "data:"] = Nothing
      | any (`isSuffixOf` lowerReference) [".js", ".mjs", ".css"] = Just reference
      | otherwise = Nothing
      where
        reference = takeWhile (`notElem` ['?', '#']) $ T.unpack $ T.strip value
        lowerReference = map toLower reference

bundleOutputCheckSpec :: Spec
bundleOutputCheckSpec = describe "checkWebAppBundleOutput" $ do
  passes "accepts a complete client build" "/" validClientBuild
  fails "rejects a missing build/index.html" "missing build/index.html" (withoutFile "build/index.html" validClientBuild)
  fails "rejects an empty build/index.html" "empty build/index.html" (withFile "build/index.html" "" validClientBuild)
  fails "rejects output written to the wrong directory" "missing build/index.html" (map (\(path, contents) -> (replaceBuild path, contents)) validClientBuild)
  fails "rejects a missing referenced script" "missing build/assets/index-abc.js" (withoutFile "build/assets/index-abc.js" validClientBuild)
  fails "rejects an empty referenced stylesheet" "empty build/assets/index-def.css" (withFile "build/assets/index-def.css" "" validClientBuild)
  fails "rejects a reference outside build/" "outside build/" (extraIndex "<script src=\"../escape.js\"></script>")
  fails "rejects an index.html without a local script" "no <script>" (withIndex "<script src=\"https://cdn.example.com/app.js\"></script>")
  fails "reads attributes with whitespace around =" "missing build/assets/spaced.css" (extraIndex "<link rel=\"stylesheet\" href = \"/assets/spaced.css\">")
  fails "reads uppercase unquoted attributes" "missing build/assets/upper.js" (extraIndex "<SCRIPT TYPE=module SRC=/assets/upper.js></SCRIPT>")
  passes "ignores data-src and commented-out markup" "/" (extraIndex "<script data-src=\"/assets/gone.js\"></script><!-- <script src=\"/assets/gone.js\"></script> -->")
  fails "does not count a modulepreload link as a script" "no <script>" (withIndex "<link rel=\"modulepreload\" href=\"/assets/index-abc.js\"><link rel=\"stylesheet\" href=\"/assets/index-def.css\">")
  fails "does not end a tag at a quoted >" "missing build/assets/quoted.css" (extraIndex "<link title=\">\" href=\"/assets/quoted.css\">")
  fails "does not start a tag at a quoted <" "missing build/assets/quoted-lt.css" (extraIndex "<link title=\"<\" href=\"/assets/quoted-lt.css\">")
  fails "does not count script markup inside a quoted attribute" "no <script>" (withIndex "<div title='<script src=\"/assets/index-abc.js\">'>content</div><link rel=stylesheet href=/assets/index-def.css>")
  fails "does not end an inline script at </scripture>" "no <script>" (withIndex "<script>const s = \"</scripture><script src='/assets/index-abc.js'>\";</script><link rel=stylesheet href=/assets/index-def.css>")
  passes "does not end an inline style at </stylesheet>" "/" (extraIndex "<style>a::after{content:\"</stylesheet><link href='/assets/fake.css'>\"}</style>")
  passes "skips the raw text of inline scripts and styles" "/" (extraIndex "<script>if (a<b) { s = \"<link href='/assets/fake.css'>\" }</script><style>a<b{}</style>")
  passes "resolves references under a non-root base path" "/app/" (withIndex "<script type=\"module\" src=\"/app/assets/index-abc.js\"></script><link rel=\"stylesheet\" href=\"/app/assets/index-def.css\">")
  failsWithBase "rejects references outside a non-root base path" "/app/" "outside the base path /app/" validClientBuild
  fails "rejects a missing ssr.json" "missing ssr.json" (withoutFile "ssr.json" validClientBuild)
  fails "rejects an ssr.json without a boolean enabled field" "no boolean" (withFile "ssr.json" "{\"enabled\":\"yes\"}" validClientBuild)
  fails "rejects an unparseable ssr.json" "no boolean" (withFile "ssr.json" "{" validClientBuild)
  fails "treats a stray < in text as text" "missing build/assets/after-text.js" (extraIndex "<p>1 < 2</p><script src=\"/assets/after-text.js\"></script>")
  fails "requires the SSR entry when SSR is enabled" "missing build-ssr/entry-server.js" (withoutFile "build-ssr/entry-server.js" completeSsrBuild)
  fails "requires the SSR server when SSR is enabled" "missing server-ssr.mjs" (withoutFile "server-ssr.mjs" completeSsrBuild)
  fails "rejects an empty SSR server" "empty server-ssr.mjs" (withFile "server-ssr.mjs" "" completeSsrBuild)
  passes "accepts a complete SSR build" "/" completeSsrBuild
  where
    validClientBuild :: [(FilePath, String)]
    validClientBuild =
      [ ("ssr.json", "{\"enabled\":false}"),
        ("build/index.html", validIndex),
        ("build/assets/index-abc.js", "console.log(1)"),
        ("build/assets/index-def.css", "body{}")
      ]

    completeSsrBuild :: [(FilePath, String)]
    completeSsrBuild =
      withFile "ssr.json" "{\"enabled\":true}" validClientBuild
        ++ [("build-ssr/entry-server.js", "export {}"), ("server-ssr.mjs", "export {}")]

    validIndex :: String
    validIndex =
      "<link rel=\"icon\" href=\"/favicon.ico\" />"
        ++ "<script type=\"module\" crossorigin src=\"/assets/index-abc.js\"></script>"
        ++ "<link rel=\"stylesheet\" crossorigin href=\"/assets/index-def.css\">"

    withIndex :: String -> [(FilePath, String)]
    withIndex html = withFile "build/index.html" html validClientBuild

    -- | The valid index.html with extra markup appended.
    extraIndex :: String -> [(FilePath, String)]
    extraIndex html = withIndex (validIndex ++ html)

    withFile :: FilePath -> String -> [(FilePath, String)] -> [(FilePath, String)]
    withFile path contents files = (path, contents) : withoutFile path files

    withoutFile :: FilePath -> [(FilePath, String)] -> [(FilePath, String)]
    withoutFile path = filter ((/= path) . fst)

    replaceBuild :: FilePath -> FilePath
    replaceBuild path
      | "build/" `isPrefixOf` path = "dist/" ++ drop (length ("build/" :: String)) path
      | otherwise = path

    passes :: String -> String -> [(FilePath, String)] -> Spec
    passes description basePath files =
      it description $ withWebApp description files $ \dir -> checkWebAppBundleOutput basePath dir >>= (`shouldBe` [])

    fails :: String -> String -> [(FilePath, String)] -> Spec
    fails description = failsWithBase description "/"

    failsWithBase :: String -> String -> String -> [(FilePath, String)] -> Spec
    failsWithBase description basePath expected files =
      it description $
        withWebApp description files $ \dir ->
          checkWebAppBundleOutput basePath dir >>= (`shouldSatisfy` any (expected `isInfixOf`))

    -- Tasty runs the cases concurrently and suites may run side by side, so
    -- each case gets its own directory, keyed by process id and case.
    withWebApp :: String -> [(FilePath, String)] -> (FilePath -> IO a) -> IO a
    withWebApp description files action = do
      tempDir <- getTemporaryDirectory
      pid <- getCurrentPid
      let dir = tempDir </> ("wasp-e2e-bundle-output-check-" ++ show pid ++ "-" ++ map sanitize description)
      bracket_ (removePathForcibly dir >> writeFiles dir) (removePathForcibly dir) (action dir)
      where
        sanitize char = if isAlphaNum char then char else '-'
        writeFiles dir =
          mapM_
            ( \(path, contents) -> do
                createDirectoryIfMissing True (takeDirectory (dir </> path))
                writeFile (dir </> path) contents
            )
            files
