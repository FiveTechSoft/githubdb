#include "FiveWin.ch"
#include "xbrowse.ch"

// githubDB + XBrowse sample
// Uses a githubDB fork as a free cloud database, results browsed with XBrowse.
//
// Two paths:
//   1. Fast read (CDN) — sub-second, no token, fetches data/<db>.json
//   2. Action query    — 10-30 s, needs GITHUB_TOKEN, SQL via repository_dispatch

#define OWNER_DEFAULT  "FiveTechSoft"
#define REPO           "githubdb"
#define BRANCH         "main"
#define DB             "example"

STATIC oWnd, oBrw, oGetSql, cSql, oGetOwner, cOwner, oGetToken, cToken
STATIC aResult := {}

//----------------------------------------------------------------------------//

FUNCTION Main()

   FW_SetUnicode( .T. )

   aResult := Array( 1, 4 )   // table + max columns from example DB
   aResult[ 1 ] := { "", 0, "", "" }

   cSql   := "SELECT * FROM clients"
   cOwner := hb_GetEnv( "OWNER" )
   if Empty( cOwner )
      cOwner := OWNER_DEFAULT
   endif
   cToken := Space( 60 )
   if ! Empty( hb_GetEnv( "GITHUB_TOKEN" ) )
      cToken := hb_GetEnv( "GITHUB_TOKEN" )
   endif

   DEFINE WINDOW oWnd TITLE "githubDB + XBrowse" FROM 2, 2 TO 40, 130

   @ 10, 10 SAY "Owner:" OF oWnd PIXEL
   @ 24, 10 GET oGetOwner VAR cOwner OF oWnd SIZE 120, 16 PIXEL

   @ 10, 150 SAY "Token:" OF oWnd PIXEL
   @ 24, 150 GET oGetToken VAR cToken OF oWnd SIZE 400, 16 PIXEL

   @ 50, 10 SAY "SQL:" OF oWnd PIXEL
   @ 64, 10 GET oGetSql VAR cSql OF oWnd SIZE 640, 16 PIXEL

   @ 90, 10 BUTTON "Fast read (CDN)" OF oWnd SIZE 90, 26 PIXEL ;
      ACTION FastRead()
   @ 90, 110 BUTTON "Query (Action)" OF oWnd SIZE 90, 26 PIXEL ;
      ACTION ActionQuery()
   @ 90, 210 BUTTON "Schema" OF oWnd SIZE 70, 26 PIXEL ;
      ACTION ShowSchema()

   @ 130, 10 XBROWSE oBrw OF oWnd SIZE -10, -10 PIXEL ;
      AUTOCOLS DATASOURCE aResult AUTOSORT CELL LINES FASTEDIT
   oBrw:nColDividerStyle := LINESTYLE_BLACK
   oBrw:CreateFromCode()

   ACTIVATE WINDOW oWnd CENTERED
RETURN NIL

//----------------------------------------------------------------------------//
// Fast read path: fetch data/<db>.json from raw CDN (sub-second, no token)
//----------------------------------------------------------------------------//

STATIC FUNCTION FastRead()
   LOCAL cUrl, cJson, hDb, hTbl, cTable, aRows
   LOCAL aRet := {}

   CursorWait()
   SysRefresh()

   cUrl := "https://raw.githubusercontent.com/" + AllTrim( cOwner ) + ;
           "/" + REPO + "/" + BRANCH + "/data/" + DB + ".json"

   cJson := WinHttpGet( cUrl )

   CursorArrow()

   if Empty( cJson )
      MsgStop( "No data. Is the owner/repo correct?", "Fast read" )
      RETURN NIL
   endif

   hb_jsonDecode( cJson, @hDb )

   if hDb == NIL .OR. !hb_HHasKey( hDb, "tables" )
      MsgStop( "Invalid database format", "Fast read" )
      RETURN NIL
   endif

   // Merge all tables into flat array for XBrowse
   aRet  := {}

   for each cTable in hb_HKeys( hDb[ "tables" ] )
      hTbl := hDb[ "tables" ][ cTable ]
      aRows := hTbl[ "rows" ]

      // Add rows with table name prepended
      AEval( aRows, { |aRow| AAdd( aRet, RowWithTable( cTable, aRow ) ) } )
   next

   aResult := aRet
   oBrw:SetArray( aResult, NIL, NIL, .T. )
   oBrw:Refresh()
   oWnd:SetText( "githubDB + XBrowse — Fast Read: " + ;
                 AllTrim( Str( Len( aResult ) ) ) + " rows" )
RETURN NIL

//----------------------------------------------------------------------------//
// Action query: repository_dispatch + poll (10-30 s, needs token)
//----------------------------------------------------------------------------//

STATIC FUNCTION ActionQuery()
   LOCAL cId, cPayload, cUrl, cResult, hResult
   LOCAL nTimer, nTimeout := 120000  // 120 s
   LOCAL lDone := .F.

   if Empty( AllTrim( cToken ) )
      MsgStop( "GITHUB_TOKEN required for queries." + CRLF + ;
               "Get one from https://github.com/settings/tokens" + CRLF + ;
               "(Contents: Read and write)", "Token needed" )
      RETURN NIL
   endif

   // Simple unique id (GUID-like)
   cId := hb_ntos( hb_Random( 0x7FFFFFFF ) ) + "-" + ;
          hb_ntos( hb_Random( 0x7FFFFFFF ) ) + "-" + ;
          hb_ntos( hb_Random( 0x7FFFFFFF ) ) + "-" + ;
          hb_ntos( hb_Random( 0x7FFFFFFF ) )

   cPayload := '{ "event_type": "query", "client_payload": { ' + ;
               '"id": "' + cId + '", ' + ;
               '"db": "' + DB + '", ' + ;
               '"sql": ' + hb_jsonEncode( cSql ) + ' } }'

   cUrl := "https://api.github.com/repos/" + AllTrim( cOwner ) + ;
           "/" + REPO + "/dispatches"

   CursorWait()
   SysRefresh()
   WinHttpPost( cUrl, cPayload, AllTrim( cToken ) )

   // Poll for result
   cUrl := "https://raw.githubusercontent.com/" + AllTrim( cOwner ) + ;
           "/" + REPO + "/" + BRANCH + "/results/" + cId + ".json"

   nTimer := hb_MilliSeconds()
   do while hb_MilliSeconds() - nTimer < nTimeout
      cResult := WinHttpGet( cUrl )
      if !Empty( cResult ) .AND. Left( cResult, 1 ) == "{"
         lDone := .T.
         EXIT
      endif
      SysWait( 3 )   // 3 seconds between polls
      SysRefresh()
   enddo

   CursorArrow()

   if !lDone
      MsgStop( "Timeout after " + AllTrim( Str( nTimeout / 1000 ) ) + "s", "Query" )
      RETURN NIL
   endif

   hb_jsonDecode( cResult, @hResult )

   if hResult != NIL .AND. hb_HHasKey( hResult, "ok" ) .AND. hResult[ "ok" ]
      aResult := hResult[ "rows" ]
      oBrw:SetArray( aResult, NIL, NIL, .T. )
      oBrw:Refresh()
      oWnd:SetText( "githubDB + XBrowse — Query: " + ;
                    AllTrim( Str( hResult[ "rowCount" ] ) ) + " rows, " + ;
                    AllTrim( Str( hResult[ "elapsedMs" ] ) ) + " ms engine" )
   else
      MsgStop( hResult[ "error" ], "githubDB error" )
   endif
RETURN NIL

//----------------------------------------------------------------------------//
// Show database schema (fast read + parse column definitions)
//----------------------------------------------------------------------------//

STATIC FUNCTION ShowSchema()
   LOCAL cUrl, cJson, hDb, hTbl, cTable, aSchema := {}, hCol

   CursorWait()
   SysRefresh()

   cUrl := "https://raw.githubusercontent.com/" + AllTrim( cOwner ) + ;
           "/" + REPO + "/" + BRANCH + "/data/" + DB + ".json"
   cJson := WinHttpGet( cUrl )

   CursorArrow()

   if Empty( cJson )
      MsgStop( "Cannot fetch schema", "Schema" )
      RETURN NIL
   endif

   hb_jsonDecode( cJson, @hDb )

   for each cTable in hb_HKeys( hDb[ "tables" ] )
      hTbl := hDb[ "tables" ][ cTable ]
      for each hCol in hTbl[ "columns" ]
         AAdd( aSchema, { cTable, hCol[ "name" ], hCol[ "type" ], ;
                          IIF( hb_HHasKey( hTbl, "embed_from" ) .AND. ;
                               hTbl[ "embed_from" ] == hCol[ "name" ], ;
                               "<— embed_from", "" ) } )
      next
   next

   aResult := aSchema
   oBrw:SetArray( aResult, NIL, NIL, .T. )
   oBrw:Refresh()
   oWnd:SetText( "githubDB + XBrowse — Schema: " + DB + " (" + ;
                 AllTrim( Str( Len( aSchema ) ) ) + " columns)" )
RETURN NIL

//----------------------------------------------------------------------------//
// HTTP helpers — WinHttp COM (no curl/DLL dependency, works on any Windows)
//----------------------------------------------------------------------------//

STATIC FUNCTION WinHttpGet( cUrl )
   LOCAL oHttp, cResult := ""
   TRY
      oHttp := CreateObject( "WinHttp.WinHttpRequest.5.1" )
   CATCH
      RETURN ""
   END
   if oHttp == NIL
      RETURN ""
   endif
   TRY
      oHttp:SetTimeouts( 30000, 30000, 30000, 30000 )
      oHttp:Open( "GET", cUrl, .F. )
      oHttp:Send()
      cResult := oHttp:ResponseText
   CATCH
   END
RETURN cResult

//----------------------------------------------------------------------------//

STATIC FUNCTION WinHttpPost( cUrl, cBody, cToken )
   LOCAL oHttp, oErr
   TRY
      oHttp := CreateObject( "WinHttp.WinHttpRequest.5.1" )
   CATCH
      MsgStop( "Cannot create WinHttp object", "Error" )
      RETURN ""
   END
   if oHttp == NIL
      RETURN ""
   endif
   TRY
      oHttp:SetTimeouts( 30000, 30000, 30000, 30000 )
      oHttp:Open( "POST", cUrl, .F. )
      oHttp:SetRequestHeader( "Authorization", "Bearer " + cToken )
      oHttp:SetRequestHeader( "Accept", "application/vnd.github+json" )
      oHttp:SetRequestHeader( "Content-Type", "application/json" )
      oHttp:Send( cBody )
   CATCH oErr
      MsgStop( oErr:Description, "HTTP POST error" )
   END
RETURN ""

//----------------------------------------------------------------------------//
// Helper: prepend a value to an array, returning a new array
//----------------------------------------------------------------------------//

STATIC FUNCTION RowWithTable( cTable, aRow )
   LOCAL aResult := Array( Len( aRow ) + 1 )
   LOCAL i
   aResult[ 1 ] := cTable
   for i := 1 to Len( aRow )
      aResult[ i + 1 ] := aRow[ i ]
   next
RETURN aResult

//----------------------------------------------------------------------------//
